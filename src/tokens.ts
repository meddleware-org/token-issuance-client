// Discover the coins a wallet deployed or still controls. Read-only.
//
// `init` sends the capabilities that exist to the publisher, so an owned `0x2::coin::TreasuryCap<T>` or
// `0x2::coin_registry::MetadataCap<T>` names a coin the wallet can mint or edit. A fixed supply with
// frozen metadata has neither (the registry holds the supply and the metadata cap was deleted), so those
// coins are found the other way round: the wallet holds a balance of a coin whose package it published.
//
// Role: the "my tokens" list. Every listing is paged with a bound (a node that always reports another page must not hang the caller or return a list that only looks complete), and the
// publisher lookup is bounded and concurrent-limited. Main export: `listMyTokens`. Tested in `tests/tokens.test.ts`; read-only (no signing, no state).

import { normalizeSuiAddress } from '@mysten/sui/utils'
import { frameworkTypeArgument, typePackage } from './typeNames.js'
import type { DeployedToken, OwnedObjectsClient } from './types.js'

/** Pages read per listing before {@link listMyTokens} gives up (50 entries per page by default). */
export const DEFAULT_MAX_TOKEN_PAGES = 20

/** Distinct held coin types whose publisher {@link listMyTokens} will look up before giving up. */
export const DEFAULT_MAX_HELD_COIN_TYPES = 200

/** Packages at or below this address are system packages (std, sui, sui_system, …), never a user's coin. */
const SYSTEM_PACKAGE_LIMIT = 0xffn

/** Held coin types read concurrently when looking up publishers. */
const LOOKUP_CONCURRENCY = 5

/** True for a system package (`0x1`, `0x2`, …), whose coins are never a user's own. */
const isSystemPackage = (pkg: string) => BigInt(pkg) <= SYSTEM_PACKAGE_LIMIT

/**
 * Every capability of `type` the owner holds, as a map from coin type to the capability's object id (the first one per coin).
 * @param coinOf - extracts the coin type from a capability's type, or `null` if the object is not exactly that capability
 * @throws {Error} if the listing needs more than `maxPages` pages
 */
async function ownedCaps(
  client: OwnedObjectsClient,
  owner: string,
  type: string,
  coinOf: (objectType: string) => string | null,
  maxPages: number,
): Promise<Map<string, string>> {
  // coin type → capability object id.
  const found = new Map<string, string>()
  let cursor: string | null = null
  // A bounded loop: more pages than the limit is an error, never a silently short list.
  for (let page = 0; page < maxPages; page++) {
    // A type filter without type arguments matches every instantiation.
    const res: Awaited<ReturnType<OwnedObjectsClient['core']['listOwnedObjects']>> = await client.core.listOwnedObjects({
      owner,
      type,
      cursor,
    })
    for (const obj of res.objects ?? []) {
      // The exact-type check: an object that is not this capability (or a look-alike) gives `null` and is skipped.
      const coinType = coinOf(obj.type)
      if (coinType && !found.has(coinType)) found.set(coinType, obj.objectId)
    }
    if (!res.hasNextPage || !res.cursor) return found
    cursor = res.cursor
  }
  throw new Error(`more than ${maxPages} pages of ${type} owned by ${owner}`)
}

/**
 * Every coin type the owner holds a balance of.
 * @throws {Error} if the listing needs more than `maxPages` pages
 */
async function heldCoinTypes(client: OwnedObjectsClient, owner: string, maxPages: number): Promise<string[]> {
  const types: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const res: Awaited<ReturnType<OwnedObjectsClient['core']['listBalances']>> = await client.core.listBalances({ owner, cursor })
    for (const b of res.balances ?? []) types.push(b.coinType)
    if (!res.hasNextPage || !res.cursor) return types
    cursor = res.cursor
  }
  throw new Error(`more than ${maxPages} pages of balances held by ${owner}`)
}

/** True if `owner` sent the transaction that published `packageId`. */
async function publishedBy(client: OwnedObjectsClient, packageId: string, owner: string): Promise<boolean> {
  // A package object records the transaction that published it...
  const { object } = await client.core.getObject({ objectId: packageId, include: { previousTransaction: true } })
  if (!object.previousTransaction) return false
  // ...and that transaction records its sender.
  const res = await client.core.getTransaction({ digest: object.previousTransaction, include: { transaction: true } })
  // A client may report the transaction under either key; the sender is read from whichever exists.
  const sender = (res.Transaction ?? res.FailedTransaction)?.transaction?.sender
  return typeof sender === 'string' && normalizeSuiAddress(sender) === normalizeSuiAddress(owner)
}

/**
 * List the coins `owner` deployed or controls, one entry per coin type: those whose `TreasuryCap` or
 * `MetadataCap` the wallet owns, then those the wallet holds a balance of in a package it published (this
 * is what lists a fixed supply with frozen metadata, which has no capability).
 *
 * @throws {Error} if a listing is longer than `maxPages` pages, the wallet holds more than `maxHeldCoinTypes`
 *   unrelated coin types to check, or a read fails.
 */
export async function listMyTokens(
  client: OwnedObjectsClient,
  owner: string,
  opts: { maxPages?: number; maxHeldCoinTypes?: number } = {},
): Promise<DeployedToken[]> {
  // The bounds, from the options or the defaults.
  const maxPages = opts.maxPages ?? DEFAULT_MAX_TOKEN_PAGES
  const maxHeld = opts.maxHeldCoinTypes ?? DEFAULT_MAX_HELD_COIN_TYPES
  // Step 1: coins the wallet has a capability for.
  const treasuries = await ownedCaps(client, owner, '0x2::coin::TreasuryCap', (t) => frameworkTypeArgument(t, 'coin', 'TreasuryCap'), maxPages)
  const metadataCaps = await ownedCaps(
    client,
    owner,
    '0x2::coin_registry::MetadataCap',
    (t) => frameworkTypeArgument(t, 'coin_registry', 'MetadataCap'),
    maxPages,
  )

  // Every coin type reaching `entry` came from a parsed cap type or a parsed held type, so `typePackage` is set;
  // the cap ids are read behind a `has` check on the same map.
  const entry = (coinType: string): DeployedToken => ({
    coinType,
    packageId: typePackage(coinType)!, // parsed above: a coin type with no package never gets here
    ...(treasuries.has(coinType) ? { treasuryCapId: treasuries.get(coinType)! } : {}), // `has` just checked
    ...(metadataCaps.has(coinType) ? { metadataCapId: metadataCaps.get(coinType)! } : {}), // `has` just checked
    label: coinType.split('::').pop() ?? coinType,
  })
  // One entry per coin type, whichever capability named it.
  const out = [...new Set([...treasuries.keys(), ...metadataCaps.keys()])].map(entry)

  // Step 2: capability-less coins: held, and published by this wallet.
  const known = new Set(out.map((t) => t.coinType))
  const candidates = new Map<string, string[]>() // package id → coin types held from it
  for (const raw of await heldCoinTypes(client, owner, maxPages)) {
    // Skip a type with no package and the system packages' coins (SUI and the like).
    const pkg = typePackage(raw)
    if (!pkg || isSystemPackage(pkg)) continue
    // The balance lists the type with a short address; normalise it so it compares with the capability-derived ones.
    const coinType = raw.replace(/^0x[0-9a-fA-F]+/, pkg)
    if (known.has(coinType)) continue
    candidates.set(pkg, [...(candidates.get(pkg) ?? []), coinType])
  }
  // Looking up each package's publisher costs two reads; a wallet holding many unrelated coins is refused rather than slowly scanned.
  if (candidates.size > maxHeld) {
    throw new Error(`${owner} holds coins from ${candidates.size} packages (limit ${maxHeld}); cannot tell which it published`)
  }
  const packages = [...candidates.keys()]
  // The packages this wallet published, found a few at a time so a public node is not flooded.
  const mine = new Set<string>()
  for (let i = 0; i < packages.length; i += LOOKUP_CONCURRENCY) {
    const chunk = packages.slice(i, i + LOOKUP_CONCURRENCY)
    const flags = await Promise.all(chunk.map((pkg) => publishedBy(client, pkg, owner)))
    chunk.forEach((pkg, j) => flags[j] && mine.add(pkg))
  }
  // Add the held coins of the packages the wallet published (a fixed supply with frozen metadata is found only this way).
  for (const [pkg, types] of candidates) {
    if (!mine.has(pkg)) continue
    for (const coinType of new Set(types)) out.push(entry(coinType))
  }
  return out
}
