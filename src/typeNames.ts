// Exact, normalised type matching. Object types are compared as parsed struct tags — never by
// substring — so a look-alike package (`0xbad::coin::TreasuryCap<…>`) or a nested generic never
// matches a framework type.
//
// Role: every decision "is this object a TreasuryCap?" goes through here, because a substring match would accept a look-alike and a person could be shown (or sent) the wrong object.
// Main exports: `isFrameworkType`, `frameworkTypeArgument`, `treasuryCapCoinType`, `typePackage`, `normalizeType`. Tested in `tests/typeNames.test.ts`.

// The SDK's parser and normaliser give one canonical spelling of a type, which is what comparisons need.
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from '@mysten/sui/utils'

/** The Sui framework package address (`0x2`) in its full, normalised form. */
const FRAMEWORK = normalizeSuiAddress('0x2')

/** The parsed form of a struct tag. */
type StructTag = ReturnType<typeof parseStructTag>

/** The parsed struct tag of `type`, or `null` if it is not a string or does not parse (the SDK throws; this module's contract is "null, not an exception"). */
function parse(type: unknown): StructTag | null {
  if (typeof type !== 'string') return null
  try {
    return parseStructTag(type)
  } catch {
    return null
  }
}

/** `type` normalised, or null if it is not a valid struct tag. */
export function normalizeType(type: unknown): string | null {
  const tag = parse(type)
  return tag ? normalizeStructTag(tag) : null
}

/** True if `type` is exactly the framework (`0x2`) struct `module::name` with no type arguments. */
export function isFrameworkType(type: unknown, module: string, name: string): boolean {
  const tag = parse(type)
  // Every part must match exactly: the framework address, the module, the name and no type arguments.
  return (
    tag !== null &&
    normalizeSuiAddress(tag.address) === FRAMEWORK &&
    tag.module === module &&
    tag.name === name &&
    tag.typeParams.length === 0
  )
}

/**
 * If `type` is exactly `0x2::<module>::<name><T>` with one struct type argument, the normalised `T`;
 * otherwise null.
 */
export function frameworkTypeArgument(type: unknown, module: string, name: string): string | null {
  const tag = parse(type)
  // The same exact match, but with exactly one type argument.
  if (
    !tag ||
    normalizeSuiAddress(tag.address) !== FRAMEWORK ||
    tag.module !== module ||
    tag.name !== name ||
    tag.typeParams.length !== 1
  ) {
    return null
  }
  // A type argument can be a primitive name (a string) or a struct; only a struct is a coin type.
  const [arg] = tag.typeParams
  return arg === undefined || typeof arg === 'string' ? null : normalizeStructTag(arg)
}

/** The normalised package address a struct type is defined in, or null. */
export function typePackage(type: unknown): string | null {
  const tag = parse(type)
  return tag ? normalizeSuiAddress(tag.address) : null
}

/** The `TreasuryCap<T>` coin type `T`, or null if `type` is not exactly a framework TreasuryCap. */
export function treasuryCapCoinType(type: unknown): string | null {
  return frameworkTypeArgument(type, 'coin', 'TreasuryCap')
}
