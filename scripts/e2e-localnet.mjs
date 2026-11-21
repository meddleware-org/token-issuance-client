#!/usr/bin/env node
// Real-chain end-to-end check against a local network (`sui start --with-faucet --force-regenesis`,
// gRPC on :9000, faucet on :9123). Uses only the package's public API: deployToken with a keypair
// executor, a refused-finalize recovery through finalizeToken, then listMyTokens and balance checks. Spends nothing real.
//
//   npm run e2e:localnet     (RPC_URL / FAUCET_URL override the defaults)
//
// Why: the unit tests double the chain, so only a real chain can prove that the patched bytecode verifies, that `init` applies the policies the registry then records, and that the recovery paths
// leave the coin and the balances as promised. This script is that proof; CI runs it nightly against a local node (`.github/workflows/localnet.yml`), and a red run blocks a release.
//
// Usage:      node --import ./scripts/ts-resolve.mjs scripts/e2e-localnet.mjs  (or npm run e2e:localnet)
// Environment: RPC_URL (default http://127.0.0.1:9000), FAUCET_URL (default http://127.0.0.1:9123), E2E_ALLOW_PUBLIC=1 to allow a public network (refused by default).
// Side effects: publishes five throwaway coins and spends faucet SUI on the local network it runs against; creates a random keypair in memory (never saved). Nothing is written to disk.
// Exit codes: 0 when every check passes; 1 on the first failed check (the message names it).
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { deriveObjectID } from '@mysten/sui/utils'

// The sources are imported dynamically, after the resolve hook is registered by `--import`.
const { DeployIncompleteError, DeployUnconfirmedError, deployToken, finalizeToken, toSuiTxResult } = await import('../src/deploy.ts')
const { listMyTokens } = await import('../src/tokens.ts')
const { buildPackageFiles } = await import('../src/package.ts')

// The local node and its faucet; a client and a fresh random signer (a new account every run, so no state from an earlier run can satisfy a check).
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:9000'
const FAUCET_URL = process.env.FAUCET_URL ?? 'http://127.0.0.1:9123'
const client = new SuiGrpcClient({ network: 'localnet', baseUrl: RPC_URL })
const signer = new Ed25519Keypair()
const sender = signer.toSuiAddress()
/** Print the failed check and stop (exit 1). */
const fail = (msg) => {
  console.error(`e2e-localnet: FAIL — ${msg}`)
  process.exit(1)
}

// OPS guard: this run publishes a test coin and expects a faucet. Refuse a public network unless asked.
// The chain identifier's first four bytes name the public networks; a match means this is not a throwaway chain.
const { chainIdentifier } = await client.core.getChainIdentifier()
const PUBLIC = { '4c78adac': 'testnet', '35834a8a': 'mainnet' }
const short = Buffer.from(Buffer.from((await import('@mysten/sui/utils')).fromBase58(chainIdentifier))).subarray(0, 4).toString('hex')
// Refuse a public network unless the caller says it is intended: the run publishes coins and pays fees.
if (PUBLIC[short] && process.env.E2E_ALLOW_PUBLIC !== '1') {
  fail(`${RPC_URL} serves ${PUBLIC[short]} (${short}); this script is for a local network. Set E2E_ALLOW_PUBLIC=1 to override.`)
}

// Fund the sender, then wait (up to about 30 seconds) until the balance shows.
await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: sender })
for (let i = 0; ; i++) {
  const { balance } = await client.getBalance({ owner: sender })
  if (BigInt(balance.balance) > 0n) break
  if (i > 30) fail('the faucet never funded the sender')
  await new Promise((r) => setTimeout(r, 1000))
}

// The Executor `deployToken` needs, backed by the keypair: sign and run, with effects and object types (what `toSuiTxResult` reads), and wait for indexing.
const executor = {
  async signAndExecute(transaction) {
    return toSuiTxResult(
      await client.signAndExecuteTransaction({ signer, transaction, include: { effects: true, objectTypes: true } }),
    )
  },
  async waitForTransaction(digest) {
    await client.waitForTransaction({ digest })
  },
}

// The first coin: mintable, updatable metadata, immutable package, 1000 tokens at 6 decimals (the struct name is derived, hence the empty string).
const config = {
  packageName: 'e2e_token',
  moduleName: 'e2etoken',
  structName: '',
  symbol: 'E2E',
  name: 'E2E Token',
  description: 'token-issuance-client localnet check',
  iconUrl: 'https://example.com/e2e.png',
  decimals: 6,
  initialSupply: 1_000n,
  supplyPolicy: 'mintable',
  metadataPolicy: 'updatable',
  packagePolicy: 'immutable',
  recipient: '',
  license: '0BSD',
  packageDescription: 'E2E',
  projectName: 'E2E',
}

// Deploy it, recording the phases, and check the publish: no UpgradeCap (immutable), the full supply in the wallet, and the wallet lists the coin with both caps.
const steps = []
const result = await deployToken({
  config,
  network: 'localnet',
  sender,
  feeMist: 1_000_000n,
  feeTreasury: '0x' + '9'.repeat(64),
  gasBudget: 500_000_000n,
  executor,
  onStep: (s) => steps.push(s),
})
console.log(`deployed ${result.coinType} (package ${result.packageId}, ${steps.join(' → ')})`)
if (result.upgradeCapId) fail('an immutable publish returned an UpgradeCap')

// 1000 whole tokens at 6 decimals is 10^9 base units: the initial supply reached the wallet.
const { balance } = await client.getBalance({ owner: sender, coinType: result.coinType })
if (BigInt(balance.balance) !== 1_000n * 10n ** 6n) fail(`expected 1000 tokens at 6 decimals, got ${balance.balance}`)

// The wallet's token list must show the new coin with exactly the caps the publish returned.
const tokens = await listMyTokens(client, sender)
if (!tokens.some((t) => t.coinType === result.coinType && t.treasuryCapId === result.treasuryCapId && t.metadataCapId === result.metadataCapId)) {
  fail('listMyTokens does not list the new coin')
}

// The registry's Currency records the policies `init` applied. Mintable/updatable: neither is recorded.
// `finalize_registration` replaces the pending Currency with a shared one at a derived address under the registry (0xc).
/** The coin registry's record of a coin, as JSON text: the shared Currency at the address derived from the coin type. */
const registryState = async (coinType) => {
  const objectId = deriveObjectID('0xc', `0x2::coin_registry::CurrencyKey<${coinType}>`, new Uint8Array([0]))
  return JSON.stringify((await client.core.getObject({ objectId, include: { json: true } })).object.json)
}
// A mintable, updatable coin keeps both caps, and the registry must not record it as fixed or its metadata as deleted.
const mintableState = await registryState(result.coinType)
if (/Fixed/.test(mintableState) || /Deleted/.test(mintableState)) fail(`a mintable, updatable coin is recorded as fixed/deleted: ${mintableState}`)
if (!result.metadataCapId || !result.treasuryCapId) fail('a mintable, updatable coin must keep both caps')

// The downloadable package for a localnet result: no Published.toml (an ephemeral chain has nothing durable to record), the package id in deployments.md, and a Move.lock that pins the new package.
const files = buildPackageFiles({ config: { ...config, structName: 'E2ETOKEN' }, result })
if (files['Published.toml']) fail('a localnet result must not produce Published.toml')
if (!files['deployments.md'].includes(result.packageId)) fail('deployments.md lacks the package id')
if (!files['Move.lock']?.includes('[pinned.testnet.e2e_token]') || files['Move.lock'].includes('token_issuance_template')) fail('Move.lock does not pin the generated package')

// Fixed supply + frozen metadata: init applies both in the publish transaction, so no cap ever exists and
// the registry records them (wallets and explorers read these).
// The second coin: fixed supply and frozen metadata (no capability exists at all).
const fixedConfig = { ...config, packageName: 'e2e_fixed', moduleName: 'e2efixed', symbol: 'FIX', supplyPolicy: 'fixed', metadataPolicy: 'frozen' }
// Deploy it: no fee this time (0), and the supply must still reach the wallet.
const fixed = await deployToken({
  config: fixedConfig,
  network: 'localnet',
  sender,
  feeMist: 0n,
  feeTreasury: '0x' + '9'.repeat(64),
  gasBudget: 500_000_000n,
  executor,
})
if (fixed.treasuryCapId || fixed.metadataCapId) fail('a fixed supply with frozen metadata must have no TreasuryCap or MetadataCap')
// The initial supply is minted at publish, so the balance is there although no cap exists.
const fixedBalance = await client.getBalance({ owner: sender, coinType: fixed.coinType })
if (BigInt(fixedBalance.balance.balance) !== 1_000n * 10n ** 6n) fail(`fixed supply: expected 1000 tokens, got ${fixedBalance.balance.balance}`)
// The registry is what wallets and explorers read: it must say Fixed supply and Deleted metadata cap.
const fixedState = await registryState(fixed.coinType)
if (!/Fixed/.test(fixedState)) fail(`the registry does not record the fixed supply: ${fixedState}`)
if (!/Deleted/.test(fixedState)) fail(`the registry does not record the deleted MetadataCap: ${fixedState}`)
// Belt and braces: the wallet must not own a cap of that coin (the registry took the supply and the metadata cap was deleted).
const owned = await client.core.listOwnedObjects({ owner: sender })
if (owned.objects.some((o) => /TreasuryCap|MetadataCap/.test(o.type) && o.type.includes(fixed.packageId.slice(2)))) {
  fail('the sender owns a cap of the fixed, frozen coin')
}
console.log(`fixed ${fixed.coinType}: no caps exist; the registry records Fixed supply and Deleted metadata cap`)
// listMyTokens finds it although it has no capability: the wallet holds it and published its package.
// A second listing, now including the capability-less coin; an unrelated coin type must not appear.
const listed = await listMyTokens(client, sender)
const fixedListed = listed.find((t) => t.coinType === fixed.coinType)
if (!fixedListed) fail('listMyTokens does not list the fixed, frozen coin')
if (fixedListed.treasuryCapId || fixedListed.metadataCapId) fail('the fixed, frozen coin is listed with a capability')
if (listed.some((t) => t.coinType.includes('::none::'))) fail('listMyTokens listed an unrelated coin')

// Equal constants: a symbol that equals the name, and an empty description and icon, would leave duplicate
// entries in the constant pool, which the bytecode verifier rejects at publish. The patcher merges them.
// The publish itself is the check: the verifier would reject duplicates on-chain.
const same = await deployToken({
  config: { ...config, packageName: 'e2e_same', moduleName: 'e2esame', symbol: 'SAME', name: 'SAME', description: '', iconUrl: '', initialSupply: 0n },
  network: 'localnet',
  sender,
  feeMist: 0n,
  feeTreasury: '0x' + '9'.repeat(64),
  gasBudget: 500_000_000n,
  executor,
})
console.log(`equal constants published and verified: ${same.coinType}`)

// Recovery: refuse the finalize signature, then finish the published coin with finalizeToken.
// An executor that refuses (once) the finalize transaction, as a person closing the wallet prompt would.
let refused = false
const refusingOnce = {
  ...executor,
  async signAndExecute(transaction) {
    if (refused === false && JSON.stringify(transaction.getData()).includes('finalize_registration')) {
      refused = true
      throw new Error('User rejected the request')
    }
    return executor.signAndExecute(transaction)
  },
}
// The deployment must stop with `DeployIncompleteError`, whose `pending` finishes the job; anything else is a failure.
let pending = null
try {
  await deployToken({
    config: { ...config, packageName: 'e2e_retry', moduleName: 'e2eretry', symbol: 'RTY', supplyPolicy: 'fixed' },
    network: 'localnet',
    sender,
    feeMist: 0n,
    feeTreasury: '0x' + '9'.repeat(64),
    gasBudget: 500_000_000n,
    executor: refusingOnce,
  })
  fail('a refused finalize did not raise DeployIncompleteError')
} catch (e) {
  if (!(e instanceof DeployIncompleteError)) throw e
  pending = e.pending
}
// Finish it, and check the supply is intact and still recorded as fixed.
const finished = await finalizeToken({ pending, executor })
const retried = await client.getBalance({ owner: sender, coinType: finished.coinType })
if (BigInt(retried.balance.balance) !== 1_000n * 10n ** 6n) fail(`retry left ${retried.balance.balance}, expected 1000 tokens`)
if (finished.treasuryCapId) fail('fixed supply: a TreasuryCap exists after the retry')
if (!/Fixed/.test(await registryState(finished.coinType))) fail('fixed supply: the registry does not record it after the retry')
console.log(`recovered ${finished.coinType}: finalize refused once, finished with finalizeToken (supply minted at publish, fixed in the registry)`)

// A second finalize of the already finalized coin is refused by the chain (the pending Currency reference
// is stale) and changes nothing: no second registration, no extra supply, the same registry state.
// Retrying a finalize that already ran must be refused by the chain and change nothing.
const registryBefore = await registryState(finished.coinType)
let secondRefusal = null
try {
  await finalizeToken({ pending, executor })
} catch (e) {
  secondRefusal = e
}
if (!secondRefusal) fail('a second finalize of an already finalized coin was not refused')
if (secondRefusal instanceof DeployUnconfirmedError) fail(`the second finalize reached the chain and was confirmed: ${secondRefusal.message}`)
// And nothing changed: the balance is the original supply, and the registry state (checked next) is unchanged.
const afterSecond = await client.getBalance({ owner: sender, coinType: finished.coinType })
if (BigInt(afterSecond.balance.balance) !== 1_000n * 10n ** 6n) fail(`the refused finalize changed the balance to ${afterSecond.balance.balance}`)
if ((await registryState(finished.coinType)) !== registryBefore) fail('the refused finalize changed the registry state')
console.log(`second finalize refused without effect: ${String(secondRefusal.message).slice(0, 120)}`)

console.log('e2e-localnet: OK — publish, finalize, fixed/frozen registry state, recovery, refused second finalize, balance, listMyTokens and package generation')
