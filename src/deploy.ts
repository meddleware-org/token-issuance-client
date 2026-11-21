// @meddleware/token-issuance-client/deploy — patch → publish → confirm → finalize → result, decoupled
// from any wallet through an `Executor`.
//
// Role: the one orchestrator of a deployment, and the place that decides what a person is told when something fails half way. The coin exists on-chain from the moment the publish executes, so
// every later failure is reported as such (with what remains to do) and never invites a second deploy, which would publish a second coin and charge the fee again.
// Main exports: `deployToken`, `finalizeToken`, `Executor`, and the three error classes. Tested in `tests/deploy.test.ts`.

import type { Transaction } from '@mysten/sui/transactions'
import { assertResultMatchesPolicy, extractPublishResult, type SuiTxResult } from './results.js'
import { deriveStructName } from './rules.js'
import { patchTokenModule } from './template/patch.js'
import { buildFinalizeTransaction, buildPublishTransaction, finalizeHasWork, type CurrencyRef } from './transactions.js'
import type { PublishResult, TokenConfig, TokenNetwork } from './types.js'

/** Signs and runs transactions for {@link deployToken} (a wallet adapter, or a keypair in tests). */
export interface Executor {
  /** Sign and execute; the result must carry the object changes and the effects status. */
  signAndExecute(tx: Transaction): Promise<SuiTxResult>
  /** Resolve once `digest` is indexed, so the objects it created can be read. */
  waitForTransaction(digest: string): Promise<void>
}

/** The phases of a deployment, in order, for a progress display. */
export type DeployStep = 'patching' | 'publishing' | 'confirming' | 'finalizing' | 'confirming-finalize' | 'done'

/** What `deployToken` needs. */
export interface DeployArgs {
  /** The token's choices (validated by the patcher before anything is signed). */
  config: TokenConfig
  /** The network being deployed to. */
  network: TokenNetwork
  /** The deployer's address. */
  sender: string
  /** The platform fee in MIST. */
  feeMist: bigint
  /** Where the fee goes (a full, non-zero address; checked by the publish builder). */
  feeTreasury: string
  /** The gas budget in MIST for each transaction. */
  gasBudget: bigint
  /** Signs and runs the transactions. */
  executor: Executor
  /** Called as each phase starts. */
  onStep?: (step: DeployStep) => void
}

/** Only an explicit `success` status counts; a missing status is a failure, never a success. */
function assertSuccess(res: SuiTxResult, what: string): void {
  // Anything but an explicit success is a failure, including a result with no status at all.
  const status = res.effects?.status?.status
  if (status !== 'success') {
    throw new Error(`${what} failed: ${res.effects?.status?.error ?? status ?? 'no effects status returned'}`)
  }
}

/** Everything needed to finish a published token with {@link finalizeToken}. */
export interface PendingFinalize {
  /** The validated config (struct name derived, recipient defaulted to the sender). */
  config: TokenConfig
  /** The publish result: package, coin type and the caps the finalize step acts on. */
  result: PublishResult
  /** The pending `Currency<T>`'s reference from the publish effects. */
  currencyRef?: CurrencyRef
  /** The deployer, who still owns what `init` created. */
  sender: string
  /** The gas budget for the finalize transaction. */
  gasBudget: bigint
}

/**
 * Something failed after the publish transaction executed: the coin exists on-chain, so the caller
 * must not run a fresh deploy (it would publish a second coin and pay the fee again).
 * `publishDigest` identifies the publish. Subclasses say what remains to do.
 */
export class PublishedError extends Error {
  /** The publish transaction's digest, so the person (or support) can find the coin. */
  readonly publishDigest: string

  /** @param message - what happened and what remains; @param publishDigest - the executed publish; @param cause - the underlying error */
  constructor(message: string, publishDigest: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'PublishedError'
    this.publishDigest = publishDigest
  }
}

/**
 * The coin was published, but the finalize step (currency registration and routing the caps and the
 * initial supply to the recipient) did not complete — the second signature was refused or the
 * transaction failed. `pending` lets the caller retry with {@link finalizeToken}; until then
 * what `init` created stays with the sender (the policies themselves were already applied by `init`).
 */
export class DeployIncompleteError extends PublishedError {
  /** Everything `finalizeToken` needs to finish the setup. */
  readonly pending: PendingFinalize

  /** @param pending - the unfinished deployment; @param cause - why the setup did not complete */
  constructor(pending: PendingFinalize, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`Published ${pending.result.coinType}, but finishing its setup failed: ${reason}`, pending.result.digest, cause)
    this.name = 'DeployIncompleteError'
    this.pending = pending
  }
}

/**
 * The finalize transaction executed successfully but could not be confirmed (e.g. indexing timed
 * out). The coin is fully set up; do **not** retry — `result` is the deploy's outcome.
 */
export class DeployUnconfirmedError extends PublishedError {
  /** The completed deployment's outcome. */
  readonly result: PublishResult
  /** The finalize transaction's digest. */
  readonly digest: string

  /** @param result - the outcome; @param digest - the executed finalize; @param cause - why confirmation failed */
  constructor(result: PublishResult, digest: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`Finalized ${result.coinType} (transaction ${digest}), but confirmation failed: ${reason}`, result.digest, cause)
    this.name = 'DeployUnconfirmedError'
    this.result = result
    this.digest = digest
  }
}

/**
 * Run (or retry) the finalize step of a published token: register the currency and move what `init` left
 * with the sender to the recipient. Resolves once confirmed.
 *
 * A retry after an attempt that executed on-chain, but whose executor then threw, is safe: the receiving
 * reference of the pending Currency is stale and the sender no longer owns the objects, so the repeat is
 * rejected without effect (the policies were applied by `init`, and nothing is minted here).
 *
 * @throws {Error} if the finalize transaction fails or returns no success status (retryable).
 * @throws {DeployUnconfirmedError} if it executed but could not be confirmed (do not retry).
 */
export async function finalizeToken(args: {
  pending: PendingFinalize
  executor: Executor
  onStep?: (step: DeployStep) => void
}): Promise<PublishResult> {
  // Nothing to register or move (no currency reference and the recipient is the sender): the deployment is already complete.
  if (!finalizeHasWork(args.pending)) {
    args.onStep?.('done')
    return args.pending.result
  }
  // Two parts, so a failure to CONFIRM is told apart from a failure to EXECUTE: the first must not be retried, the second may be.
  const digest = await executeFinalize(args)
  return confirmFinalize(args, digest)
}

/** Sign and execute the finalize transaction; resolves with its digest once it succeeded. */
async function executeFinalize(args: {
  pending: PendingFinalize
  executor: Executor
  onStep?: (step: DeployStep) => void
}): Promise<string> {
  const { pending, executor, onStep } = args
  const { result } = pending
  // The second wallet approval.
  onStep?.('finalizing')
  const fin = await executor.signAndExecute(
    buildFinalizeTransaction({
      config: pending.config,
      coinType: result.coinType,
      treasuryCapId: result.treasuryCapId,
      metadataCapId: result.metadataCapId,
      initialCoinId: result.initialCoinId,
      currencyRef: pending.currencyRef,
      sender: pending.sender,
      gasBudget: pending.gasBudget,
    }),
  )
  // A transaction that ran but failed on-chain is an error (and retryable: nothing changed).
  assertSuccess(fin, 'Finalize')
  return fin.digest
}

/** Wait for an executed finalize. A failure here is not a reason to retry: the setup is on-chain. */
async function confirmFinalize(
  args: { pending: PendingFinalize; executor: Executor; onStep?: (step: DeployStep) => void },
  digest: string,
): Promise<PublishResult> {
  args.onStep?.('confirming-finalize')
  // The transaction already succeeded; if only the wait fails (an indexing timeout), say the setup is on-chain and not to retry.
  try {
    await args.executor.waitForTransaction(digest)
  } catch (e) {
    throw new DeployUnconfirmedError(args.pending.result, digest, e)
  }
  args.onStep?.('done')
  return args.pending.result
}

/**
 * Deploy a token end to end: patch the template (its constants carry the initial supply and the supply and
 * metadata policies, which `init` applies in the publish transaction), publish it (with the fee and the
 * package policy), then finalize — register the currency and route what `init` created to the recipient.
 * Resolves once the finalize transaction is confirmed.
 *
 * @throws {Error} if the config breaks a token rule or the publish fails.
 * @throws {PublishedError} if the publish executed but its effects do not name one package and one Currency,
 *   or what it created does not match the chosen policies.
 * @throws {DeployIncompleteError} if the coin was published but not finished (publish confirmation
 *   or the finalize step failed); finish with {@link finalizeToken} and the error's `pending`.
 * @throws {DeployUnconfirmedError} if everything executed but the finalize was not confirmed; the
 *   coin is set up — do not retry.
 */
export async function deployToken(args: DeployArgs): Promise<PublishResult> {
  const { executor, onStep } = args
  // The struct name is always derived from the module name, so a caller cannot pass one that breaks the one-time-witness rule.
  const config: TokenConfig = { ...args.config, structName: deriveStructName(args.config.moduleName) }

  // The patcher validates the whole configuration before any bytecode is produced.
  onStep?.('patching')
  const moduleBytes = await patchTokenModule(config)

  // The first wallet approval: publish, the fee and the package policy in one transaction.
  onStep?.('publishing')
  const pub = await executor.signAndExecute(
    buildPublishTransaction({
      moduleBytes,
      sender: args.sender,
      feeMist: args.feeMist,
      feeRecipient: args.feeTreasury,
      gasBudget: args.gasBudget,
      packagePolicy: config.packagePolicy,
      recipient: config.recipient || args.sender,
    }),
  )
  // Before the publish has executed nothing exists, so a failure here is a plain error and a fresh deploy is safe.
  assertSuccess(pub, 'Publish')
  // The publish executed: from here on the coin exists, so every failure must say so (and how to
  // finish) rather than invite a second deploy.
  let parsed: ReturnType<typeof extractPublishResult>
  try {
    parsed = extractPublishResult(pub.objectChanges ?? [], {
      network: args.network,
      digest: pub.digest,
      feeRecipient: args.feeTreasury,
      feeMist: args.feeMist,
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new PublishedError(`Published (transaction ${pub.digest}), but its effects could not be read: ${reason}`, pub.digest, e)
  }
  const { result, currencyRef } = parsed
  // The patched constants must have produced the policies the person chose; if not, stop before routing caps that should not exist.
  try {
    assertResultMatchesPolicy(config, result)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new PublishedError(`Published (transaction ${pub.digest}), but its objects do not match the chosen policies: ${reason}`, pub.digest, e)
  }
  // Always finalize: `finalize_registration` promotes the pending Currency<T> to a shared object so
  // wallets read the coin's decimals; without it they show raw base units.
  const pending: PendingFinalize = {
    config: { ...config, recipient: config.recipient || args.sender },
    result,
    currencyRef,
    sender: args.sender,
    gasBudget: args.gasBudget,
  }
  // Wait until the publish is indexed, so the objects finalize moves can be read; a failure here leaves the coin published but unfinished.
  onStep?.('confirming')
  try {
    await executor.waitForTransaction(pub.digest)
  } catch (e) {
    throw new DeployIncompleteError(pending, e)
  }

  let digest: string
  try {
    digest = await executeFinalize({ pending, executor, onStep })
  } catch (e) {
    throw new DeployIncompleteError(pending, e)
  }
  // Executed: a confirmation failure from here on must not invite a retry.
  return confirmFinalize({ pending, executor, onStep }, digest)
}

// Re-exported so an executor can be built from this entry alone.
export { toSuiTxResult, type CoreExecutionResult, type SuiTxResult } from './results.js'
