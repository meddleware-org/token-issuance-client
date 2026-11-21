// @meddleware/token-issuance-client — deploy coins from @meddleware/token-issuance-template-sui.
//
// Role: this file is the root entry's public surface: it only re-exports. The heavy parts (the compiled Move module with its WASM patcher, the publish flow, the source-package
// generator) are separate entries so an app that only validates a form or lists tokens does not load them. Anything not exported from one of the entries is internal.
//
// Entry points (each loads only what it needs):
//   .           types, Move rules, transaction builders, publish-result parsing, listMyTokens
//   ./template  the compiled template module, wasm set-up and the patcher
//   ./deploy    deployToken (patch → publish → finalize) behind an Executor
//   ./package   the downloadable source package (files and zip)

// The shared types: the token's configuration and its three policies, what a publish returns, what a wallet's token list holds.
export type {
  DeployedToken,
  MetadataPolicy,
  OwnedObjectsClient,
  PackagePolicy,
  PublishResult,
  SupplyPolicy,
  TokenConfig,
  TokenNetwork,
} from './types.js'
// The Move and metadata rules, as constants and validators, so a form can show a message for each field and the generators can refuse an invalid configuration.
export {
  assertTokenConfig,
  deriveStructName,
  hasAllowedIconScheme,
  ICON_URL_ALLOWED_SCHEMES,
  isValidDecimals,
  MAX_U64,
  MOVE_IDENT,
  MOVE_RESERVED_WORDS,
  parseSupply,
  SAFE_TEXT,
  TOKEN_LIMITS,
  validateIdentifier,
  validateModuleName,
  validatePackageName,
  TEMPLATE_IMPORTED_IDENTIFIERS,
  FRAMEWORK_ADDRESS_NAMES,
} from './rules.js'
// Exact, normalised type matching (never by substring).
export {
  frameworkTypeArgument,
  isFrameworkType,
  normalizeType,
  treasuryCapCoinType,
  typePackage,
} from './typeNames.js'
// The two transactions of a deployment: publish, then finalize.
export {
  buildFinalizeTransaction,
  buildPublishTransaction,
  finalizeHasWork,
  type BuildFinalizeArgs,
  type BuildPublishArgs,
  type CurrencyRef,
} from './transactions.js'
// Reading what a publish did: the created objects, checked against the policies the person chose.
export {
  assertResultMatchesPolicy,
  extractPublishResult,
  toSuiTxResult,
  type CoreExecutionResult,
  type ObjectChange,
  type ParsedPublish,
  type SuiTxResult,
} from './results.js'
// Listing the coins a wallet deployed or still controls (read-only).
export { DEFAULT_MAX_TOKEN_PAGES, listMyTokens } from './tokens.js'
