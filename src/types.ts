// Shared types for deploying a coin from @meddleware/token-issuance-template-sui.
//
// Role: the vocabulary of the whole package. `TokenConfig` is every choice behind a token (the permanent ones and the changeable ones are marked), `PublishResult` is what a
// deployment produced, `DeployedToken` is one coin a wallet controls. Types only: no runtime code. Tested indirectly by every module that uses them.

/** A Sui network a token can be deployed to. */
export type TokenNetwork = 'testnet' | 'mainnet' | 'localnet'

/** Whether the deployer keeps the ability to mint more supply after launch. */
export type SupplyPolicy = 'fixed' | 'mintable'

/** Whether description/icon stay updatable (MetadataCap retained) or are frozen. */
export type MetadataPolicy = 'updatable' | 'frozen'

/** Whether the package code can be upgraded, or is made immutable at publish. */
export type PackagePolicy = 'immutable' | 'upgradeable'

/**
 * Every choice behind a token. `packageName`, `moduleName` and `structName` are baked into the coin
 * type and are permanent; `symbol` and `decimals` are permanent on-chain (the `name`, description and icon stay changeable by the `MetadataCap` holder unless metadata is frozen).
 */
export interface TokenConfig {
  /** Move package name, e.g. "my_token" (snake_case identifier). */
  packageName: string
  /** Move module name, e.g. "mytoken" (snake_case identifier). */
  moduleName: string
  /** One-time-witness struct name: always the module name uppercased (see `deriveStructName`). */
  structName: string

  /** The ticker, permanent on-chain (e.g. "MYT"). */
  symbol: string
  /** The display name (changeable by the MetadataCap holder unless metadata is frozen). */
  name: string
  /** A short description (changeable unless metadata is frozen). */
  description: string
  /** Icon URL (`https://` or `ipfs://`), or '' for none. */
  iconUrl: string
  /** 0..18; conventionally 9 on Sui. */
  decimals: number

  /** Whole-token initial supply minted to the recipient (before decimals scaling); 0 for none. */
  initialSupply: bigint
  /** Fixed (nobody can mint more) or mintable (the recipient keeps the TreasuryCap). */
  supplyPolicy: SupplyPolicy
  /** Updatable (the recipient keeps the MetadataCap) or frozen. */
  metadataPolicy: MetadataPolicy
  /** Immutable (no upgrade is possible) or upgradeable (the recipient keeps the UpgradeCap). */
  packagePolicy: PackagePolicy

  /** Address that receives the caps and initial supply; '' means the sender. */
  recipient: string

  /** SPDX id (e.g. "0BSD", "MIT") or "NONE" for proprietary. Affects the generated package only. */
  license: string
  /** Human-readable licence name for the generated README (defaults to the SPDX id). */
  licenseName?: string
  /** Free text used only in generated docs. */
  packageDescription: string
  /** The project's name, used only in the generated package's README. */
  projectName: string
}

/** A successful on-chain publish. */
export interface PublishResult {
  /** The network it was published to. */
  network: TokenNetwork
  /** The new package's id. */
  packageId: string
  /** Full coin type `<packageId>::<module>::<STRUCT>` (normalised). */
  coinType: string
  /** Absent for a fixed supply: the registry took the cap in `init`. */
  treasuryCapId?: string
  /** Absent for frozen metadata: `init` deleted the cap. */
  metadataCapId?: string
  /** The initial supply, one `Coin<T>` owned by the publisher until finalize moves it; absent for a zero supply. */
  initialCoinId?: string
  /** The pending `Currency<T>` object (owned by the registry address until finalized). */
  currencyId?: string
  /** Version and digest of the pending `Currency<T>` — needed for `finalize_registration`. */
  currencyVersion?: string
  currencyDigest?: string
  /** The UpgradeCap, present only for an `upgradeable` package. */
  upgradeCapId?: string
  /** The publish transaction's digest. */
  digest: string
  /** Where the platform fee was sent, and how much (MIST). */
  feeRecipient: string
  feeMist: string
}

/**
 * One coin a wallet deployed or still controls. A coin is listed when the wallet owns its `TreasuryCap<T>`
 * or `MetadataCap<T>`, or holds a balance of a coin whose package the wallet published. A fixed supply with
 * frozen metadata has no capability at all, so the last rule is what lists it.
 */
export interface DeployedToken {
  /** Full coin type, e.g. `0x<pkg>::mytoken::MYTOKEN` (normalised). */
  coinType: string
  /** The package the coin type is defined in. */
  packageId: string
  /** Object id of the owned `TreasuryCap<T>` (the wallet can mint). Absent for a fixed supply or after handing the cap on. */
  treasuryCapId?: string
  /** Object id of the owned `MetadataCap<T>` (the wallet can edit description and icon). */
  metadataCapId?: string
  /** The one-time-witness struct name — a compact display label. */
  label: string
}

/** The reads {@link listMyTokens} makes on a core Sui client (e.g. `SuiGrpcClient`). */
export interface OwnedObjectsClient {
  /** The SDK's unified core API (only the four calls this package makes). */
  core: {
    /** One page of the objects an address owns, optionally of one Move type. */
    listOwnedObjects(options: {
      /** The owner's address. */
      owner: string
      /** Only objects of this Move type. */
      type?: string
      /** Where the previous page ended. */
      cursor?: string | null
      /** The page size. */
      limit?: number
    }): Promise<{ objects: { objectId: string; type: string }[]; hasNextPage: boolean; cursor: string | null }>
    /** One page of the coin balances an address holds. */
    listBalances(options: {
      /** The holder's address. */
      owner: string
      /** Where the previous page ended. */
      cursor?: string | null
      /** The page size. */
      limit?: number
    }): Promise<{ balances: { coinType: string }[]; hasNextPage: boolean; cursor: string | null }>
    /** Reads a package object, whose `previousTransaction` is the transaction that published it. */
    getObject(options: { objectId: string; include?: { previousTransaction?: boolean } }): Promise<{
      object: { previousTransaction?: string | null }
    }>
    /** A transaction by digest, optionally with its sender. */
    getTransaction(options: { digest: string; include?: { transaction?: boolean } }): Promise<{
      Transaction?: { transaction?: { sender?: string } | null }
      FailedTransaction?: { transaction?: { sender?: string } | null }
    }>
  }
}
