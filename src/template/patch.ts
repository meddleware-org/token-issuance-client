// Client-side patching of the compiled template module.
//
// @mysten/move-bytecode-template's `update_identifiers` / `update_constants` helpers cannot
// round-trip the current binary format (v7), but `deserialize` / `serialize` do, losslessly. So the
// decoded module is patched directly: identifiers renamed in place and constant-pool entries
// overwritten. Verified end to end by scripts/e2e-localnet.mjs.
//
// Role: produce the exact bytes a person publishes. Everything in them that the person chose (names, symbol, decimals, supply and policies) is PERMANENT once published, so the patcher is
// defensive in both directions: it refuses any value that would break the bytecode (duplicate identifiers, quotes, a template placeholder), and after patching it decodes the result and
// confirms every requested value is really there, so a patcher bug can never reach the chain. Main exports: `patchTokenModule`, `patchTemplateModule`, `initTemplateWasm`,
// `configureTemplateWasm`. Tested in `tests/template.test.ts` and, against a real chain, by `scripts/e2e-localnet.mjs`.

// `init` loads the WASM; `deserialize` and `serialize` decode and encode Move bytecode losslessly (the helpers that rename and overwrite do not round-trip the current format).
import init, { deserialize, serialize } from '@mysten/move-bytecode-template'
import { bcs } from '@mysten/sui/bcs'
import { fromBase64 } from '@mysten/sui/utils'
import { assertTokenConfig, isValidDecimals, SAFE_TEXT, TOKEN_LIMITS } from '../rules.js'
import type { TokenConfig } from '../types.js'
import { TEMPLATE_DEFAULTS, TEMPLATE_IDENTIFIERS, TEMPLATE_MODULE_B64 } from './artifact.js'

/** What `@mysten/move-bytecode-template`'s browser build can load its wasm from. */
export type TemplateWasmSource = string | URL | Response | BufferSource | WebAssembly.Module

/** Where the browser build should load its WASM from (set by `configureTemplateWasm`; unset under Node). */
let wasmSource: TemplateWasmSource | undefined
/** The in-flight or finished initialisation, so the WASM is loaded once however many patches are requested. */
let initPromise: Promise<void> | null = null

/**
 * Tell the browser build where its wasm is (e.g. a bundler asset URL). Call once at start-up, before
 * the first patch; loading is deferred until then. Unneeded under Node, whose build loads its own wasm.
 */
export function configureTemplateWasm(source?: TemplateWasmSource): void {
  wasmSource = source
  // Forget any earlier initialisation: the new source must be used.
  initPromise = null
}

/**
 * Initialise the bytecode wasm once. A failure is rethrown (and the next call retries), so a
 * misconfigured asset surfaces here instead of as an obscure error mid-patch.
 */
export function initTemplateWasm(): Promise<void> {
  // Initialise once; later callers share the same promise.
  if (!initPromise) {
    // The package's types describe `init` loosely, so it is called through a narrow signature.
    const load = init as unknown as (options?: { module_or_path?: TemplateWasmSource }) => unknown
    initPromise = Promise.resolve()
      .then(() => load(wasmSource === undefined ? undefined : { module_or_path: wasmSource }))
      .then(() => undefined)
      // A failure must not be remembered: clear the promise so the next call retries (a misconfigured asset can be fixed and tried again).
      .catch((err: unknown) => {
        initPromise = null
        throw err
      })
  }
  return initPromise
}

/** The values patched into the module. */
export interface PatchParams {
  /** The Move module's name (snake_case). */
  moduleName: string
  /** The one-time-witness struct: the module name in capitals. */
  structName: string
  /** The ticker. */
  symbol: string
  /** The display name. */
  name: string
  /** The description. */
  description: string
  /** The icon URL, or empty. */
  iconUrl: string
  /** The precision, 0 to 18. */
  decimals: number
  /** Raw units (whole tokens x 10^decimals) `init` mints to the publisher. Default 0: none. */
  initialSupply?: bigint
  /** `true`: `init` hands the TreasuryCap to the coin registry (needs `initialSupply > 0`). Default false. */
  fixedSupply?: boolean
  /** `true`: `init` deletes the MetadataCap. Default false. */
  frozenMetadata?: boolean
}

/** One entry of the module's constant pool, as the decoder returns it. */
interface DecodedConstant {
  /** The constant's Move type (`U8`, `U64`, `Bool`, a vector, …). */
  type_: unknown
  /** Its BCS bytes. */
  data: number[]
}

/** The parts of a decoded module this file reads and edits. */
interface DecodedModule {
  /** The identifier table (module, struct, function and field names). */
  identifiers: string[]
  /** The constant pool the patcher overwrites. */
  constant_pool: DecodedConstant[]
  /** The functions' code, in which `LdConst` instructions point into the pool. */
  function_defs: { code?: { code?: unknown[] } | null }[]
}

/** The largest u64: the initial supply must fit (`coin::mint` takes a u64). */
const MAX_U64 = (1n << 64n) - 1n

/** BCS bytes of a `u64` constant (little-endian). */
function u64Bytes(value: bigint): number[] {
  return Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn))
}

/**
 * Merge constant-pool entries with the same type and value, and point every `LdConst` at the merged
 * entry. The Move compiler never emits duplicates, and the bytecode verifier REJECTS a module whose pool
 * has any (`DUPLICATE_ELEMENT`, at publish, after gas is spent). Patching can create them: two
 * constants that were distinct in the template become equal when the caller picks the same value (a symbol
 * and a name that match, two empty strings, `FIXED_SUPPLY` and `FROZEN_METADATA` both false).
 */
function dedupeConstantPool(json: DecodedModule): void {
  // key (type and bytes) → index in the new pool; `remap[old] = new` records where each old entry went.
  const seen = new Map<string, number>()
  const pool: DecodedConstant[] = []
  const remap: number[] = []
  json.constant_pool.forEach((c, i) => {
    const key = JSON.stringify([c.type_, c.data])
    let at = seen.get(key)
    if (at === undefined) {
      at = pool.length
      pool.push(c)
      seen.set(key, at)
    }
    remap[i] = at
  })
  // No duplicates were found: nothing to change.
  if (pool.length === json.constant_pool.length) return
  json.constant_pool = pool
  // Point every load-constant instruction at the merged entry.
  for (const def of json.function_defs) {
    for (const ins of def.code?.code ?? []) {
      if (ins !== null && typeof ins === 'object' && 'LdConst' in ins) {
        const op = ins as { LdConst: number }
        const to = remap[op.LdConst]
        // An index outside the old pool means the artefact is not the module this code was written for.
        if (to === undefined) throw new Error('constant index out of range (artefact drift?)')
        op.LdConst = to
      }
    }
  }
}

/** BCS bytes of a `vector<u8>` / `String` constant (uleb length + utf8). */
function vecU8(value: string): number[] {
  return Array.from(bcs.string().serialize(value).toBytes())
}

/** True if two byte arrays are equal. */
function sameBytes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** The maximum length of each text constant (the same limits the rules apply, restated as a lookup by field). */
const TEXT_LIMITS: Record<'symbol' | 'name' | 'description' | 'iconUrl', number> = {
  symbol: TOKEN_LIMITS.symbol,
  name: TOKEN_LIMITS.name,
  description: TOKEN_LIMITS.description,
  iconUrl: TOKEN_LIMITS.iconUrl,
}

/**
 * Patch the template with `params` and return publishable module bytes. A fresh copy of the shipped
 * module is decoded on every call.
 *
 * @throws {Error} if a value breaks the token rules or the artefact lacks an expected default.
 */
export async function patchTemplateModule(params: PatchParams): Promise<Uint8Array> {
  await initTemplateWasm()
  // A fresh decode of the shipped module on every call, so one patch can never leak into the next.
  const json = deserialize(fromBase64(TEMPLATE_MODULE_B64)) as unknown as DecodedModule

  // 1) Rename the module and struct identifiers in place (index-preserving, so every handle stays
  //    valid; the verifier does not require sorted identifiers).
  const rename: Record<string, string> = {
    [TEMPLATE_IDENTIFIERS.module]: params.moduleName,
    [TEMPLATE_IDENTIFIERS.struct]: params.structName,
  }
  json.identifiers = json.identifiers.map((id) => (Object.hasOwn(rename, id) ? (rename[id] as string) : id))
  // A duplicate identifier fails bytecode verification on-chain (after gas is spent): refuse it here.
  if (new Set(json.identifiers).size !== json.identifiers.length) {
    throw new Error(`module or struct name collides with an identifier the template already uses`)
  }

  // 2) Overwrite the five constant-pool defaults.
  // The numbers first: a bad one should fail before any text is looked at.
  if (!isValidDecimals(params.decimals)) {
    throw new Error(`decimals must be a whole number ${TOKEN_LIMITS.decimals.min}..${TOKEN_LIMITS.decimals.max}, got ${params.decimals}`)
  }
  // The decimals constant is found by its default value (the template's); not found means the artefact is not what this patcher expects.
  const u8 = json.constant_pool.find(
    (c) => c.type_ === 'U8' && sameBytes(c.data, [TEMPLATE_DEFAULTS.decimals]),
  )
  if (!u8) throw new Error(`template U8 constant ${TEMPLATE_DEFAULTS.decimals} not found (artefact drift?)`)
  u8.data = [params.decimals]

  // The supply and metadata policy: one U64 and two Bool entries, each resolved from the pristine pool.
  const initialSupply = params.initialSupply ?? 0n
  const fixedSupply = params.fixedSupply ?? false
  const frozenMetadata = params.frozenMetadata ?? false
  // The supply must fit a u64, and a fixed supply cannot be empty (the framework would abort the publish after the person has signed).
  if (initialSupply < 0n || initialSupply > MAX_U64) throw new Error('initial supply must fit a u64')
  if (fixedSupply && initialSupply === 0n) {
    throw new Error('a fixed supply needs an initial supply above zero (the framework refuses to fix an empty one)')
  }
  // The three slots, found by their template defaults. The two booleans must be different entries (they are distinct constants in the template, so one slot for both means drift).
  const supplySlot = json.constant_pool.find((c) => c.type_ === 'U64' && sameBytes(c.data, u64Bytes(BigInt(TEMPLATE_DEFAULTS.initialSupply))))
  const fixedSlot = json.constant_pool.find((c) => c.type_ === 'Bool' && sameBytes(c.data, [TEMPLATE_DEFAULTS.fixedSupply ? 1 : 0]))
  const frozenSlot = json.constant_pool.find((c) => c.type_ === 'Bool' && sameBytes(c.data, [TEMPLATE_DEFAULTS.frozenMetadata ? 1 : 0]))
  if (!supplySlot || !fixedSlot || !frozenSlot || fixedSlot === frozenSlot) {
    throw new Error('template supply or metadata policy constants not found (artefact drift?)')
  }
  // Overwrite the three.
  supplySlot.data = u64Bytes(initialSupply)
  fixedSlot.data = [fixedSupply ? 1 : 0]
  frozenSlot.data = [frozenMetadata ? 1 : 0]

  // Resolve every target slot from the PRISTINE pool before writing any of them. Looking each field
  // up in turn, after earlier fields were overwritten, lets a value equal to a later template default
  // (say a symbol of "TEMPLATE_NAME") capture the wrong slot.
  // The four text fields, and the template's own default strings (a value equal to one of them is refused below).
  const keys = ['symbol', 'name', 'description', 'iconUrl'] as const
  const defaults = new Set<string>(keys.map((k) => TEMPLATE_DEFAULTS[k]))
  const slots = keys.map((key) => {
    const next = params[key]
    if (!SAFE_TEXT.test(next)) throw new Error(`${key} contains quotes, backslashes or control characters`)
    if (next.length > TEXT_LIMITS[key]) throw new Error(`${key} exceeds ${TEXT_LIMITS[key]} characters`)
    // A value that is a template placeholder is never what the user meant, and would make the
    // published constants ambiguous with the template's own.
    if (defaults.has(next) || next.startsWith('TEMPLATE_')) {
      throw new Error(`${key} must not be a template placeholder ("${next}")`)
    }
    // The slot currently holding the template's default for this field.
    const current = vecU8(TEMPLATE_DEFAULTS[key])
    const entry = json.constant_pool.find((c) => c.type_ !== 'U8' && sameBytes(c.data, current))
    if (!entry) throw new Error(`template constant "${TEMPLATE_DEFAULTS[key]}" not found (artefact drift?)`)
    return { key, entry, next }
  })
  // Four fields, four different slots.
  if (new Set(slots.map((s) => s.entry)).size !== slots.length) {
    throw new Error('template constants are not distinct (artefact drift?)')
  }
  // Only now write the text, then merge any entries that became equal (the verifier rejects a pool with duplicates).
  for (const { entry, next } of slots) entry.data = vecU8(next)
  dedupeConstantPool(json)

  // Encode the edited module back to bytecode.
  const out = new Uint8Array(serialize(json as unknown as Parameters<typeof serialize>[0]))

  // Post-condition: decode what will be published and confirm every constant and identifier is what
  // the caller asked for, so a patcher bug can never reach the chain (the values are permanent).
  const check = deserialize(out) as unknown as DecodedModule
  // The identifiers...
  const ids = new Set(check.identifiers)
  if (!ids.has(params.moduleName) || !ids.has(params.structName)) throw new Error('patched module lacks the requested identifiers')
  for (const { key, next } of slots) {
    const want = vecU8(next)
    if (!check.constant_pool.some((c) => c.type_ !== 'U8' && sameBytes(c.data, want))) {
      throw new Error(`patched module does not carry the requested ${key}`)
    }
  }
  // ...the decimals...
  const dec = check.constant_pool.filter((c) => c.type_ === 'U8' && sameBytes(c.data, [params.decimals]))
  if (dec.length === 0) throw new Error('patched module does not carry the requested decimals')
  // ...and the supply and the two policy flags.
  const carries = (type: string, data: number[]) => check.constant_pool.some((c) => c.type_ === type && sameBytes(c.data, data))
  if (
    !carries('U64', u64Bytes(initialSupply)) ||
    !carries('Bool', [fixedSupply ? 1 : 0]) ||
    !carries('Bool', [frozenMetadata ? 1 : 0])
  ) {
    throw new Error('patched module does not carry the requested supply and metadata policy')
  }
  return out
}

/** Assert `config` meets every token rule, then patch the module for it. */
export function patchTokenModule(config: TokenConfig): Promise<Uint8Array> {
  // Validate the whole configuration first: the patcher itself checks only what it needs to keep the bytecode valid.
  assertTokenConfig(config)
  return patchTemplateModule({
    moduleName: config.moduleName,
    structName: config.structName,
    symbol: config.symbol,
    name: config.name,
    description: config.description,
    iconUrl: config.iconUrl,
    decimals: config.decimals,
    // The contract mints base units: whole tokens scaled by the decimals.
    initialSupply: config.initialSupply * 10n ** BigInt(config.decimals),
    fixedSupply: config.supplyPolicy === 'fixed',
    frozenMetadata: config.metadataPolicy === 'frozen',
  })
}
