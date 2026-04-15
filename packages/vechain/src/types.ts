/**
 * VeChain-specific transaction clause.
 * VeChain supports multi-clause transactions (multiple operations in one tx).
 */
export interface VeChainClause {
  /** Recipient address */
  to: string
  /** Transfer value in wei (decimal string) */
  value: string
  /** Contract call data (hex string) */
  data: string
}

/**
 * VeChain-specific transaction body fields.
 */
export interface VeChainTransactionBody {
  /** Chain tag (last byte of genesis block ID) */
  chainTag: number
  /** Reference to a recent block (first 8 bytes of block ID) */
  blockRef: string
  /** Expiration in blocks */
  expiration: number
  /** Transaction clauses */
  clauses: VeChainClause[]
  /** Gas price coefficient (0-255) */
  gasPriceCoef: number
  /** Maximum gas allowed */
  gas: number
  /** Transaction ID dependency (null if none) */
  dependsOn: string | null
  /** Nonce value (hex string) */
  nonce: string
}

/**
 * VeChain provider configuration.
 */
export interface VeChainProviderConfig {
  /** Thorest REST API endpoint URL */
  url: string
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
}
