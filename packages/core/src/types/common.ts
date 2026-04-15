/**
 * Represents a blockchain address as a string.
 */
export type Address = string

/**
 * Represents a transaction hash as a string.
 */
export type TxHash = string

/**
 * Represents a hex-encoded string.
 */
export type HexString = string

/**
 * Balance information for an address.
 */
export interface Balance {
  /** The address this balance belongs to */
  address: Address
  /** Balance amount as a string (to avoid floating point issues) */
  amount: string
  /** The token/asset symbol (e.g., "ETH", "BTC") */
  symbol: string
  /** Number of decimal places */
  decimals: number
}

/**
 * Information about a transaction.
 */
export interface TransactionInfo {
  /** Transaction hash */
  hash: TxHash
  /** Sender address */
  from: Address
  /** Recipient address (null for contract creation) */
  to: Address | null
  /** Amount transferred as a string */
  value: string
  /** Fee paid as a string */
  fee: string
  /** Block number the transaction was included in (null if pending) */
  blockNumber: number | null
  /** Block hash (null if pending) */
  blockHash: string | null
  /** Transaction status */
  status: 'pending' | 'confirmed' | 'failed'
  /** Unix timestamp of confirmation (null if pending) */
  timestamp: number | null
  /** Chain-specific data */
  data?: HexString
  /** Nonce or sequence number */
  nonce?: number
}

/**
 * Information about a block.
 */
export interface BlockInfo {
  /** Block number/height */
  number: number
  /** Block hash */
  hash: string
  /** Parent block hash */
  parentHash: string
  /** Unix timestamp */
  timestamp: number
  /** Transaction hashes in this block */
  transactions: TxHash[]
}

/**
 * Information about a blockchain network.
 */
export interface ChainInfo {
  /** Chain identifier (e.g., "ethereum", "bitcoin") */
  chainId: string
  /** Human-readable name */
  name: string
  /** Native token symbol */
  symbol: string
  /** Number of decimal places for the native token */
  decimals: number
  /** Whether this is a testnet */
  testnet: boolean
  /** Current block height */
  blockHeight?: number
}

/**
 * Token metadata for fungible tokens.
 */
export interface TokenMetadata {
  /** Contract/token address */
  address: Address
  /** Token name */
  name: string
  /** Token symbol */
  symbol: string
  /** Number of decimals */
  decimals: number
  /** Total supply as a string */
  totalSupply?: string
}

/**
 * Unspent Transaction Output (for UTXO-based chains like Bitcoin).
 */
export interface Utxo {
  /** Transaction hash */
  txHash: TxHash
  /** Output index */
  outputIndex: number
  /** Amount as a string */
  amount: string
  /** Script (hex-encoded) */
  script: HexString
  /** Whether the UTXO is confirmed */
  confirmed: boolean
}

/**
 * An unsigned transaction ready to be signed.
 */
export interface UnsignedTx {
  /** Sender address */
  from?: Address
  /** Recipient address */
  to: Address
  /** Amount to transfer as a string */
  amount?: string
  /** Alias for amount (for EVM compatibility) */
  value?: string
  /** Optional data payload (hex string or structured data) */
  data?: HexString | unknown
  /** Optional memo/message for the transaction */
  memo?: string
  /** Optional fee/gas parameters (chain-specific) */
  fee?: {
    fee?: string
    gasLimit?: string
    gasPrice?: string
    [key: string]: unknown
  }
  /** Optional nonce */
  nonce?: number
  /** Chain-specific extra fields */
  extra?: Record<string, unknown>
}

/**
 * @deprecated Use UnsignedTx instead. Kept for backward compatibility.
 * The old UnsignedTx required `from` and `value` as mandatory fields.
 */
export interface LegacyUnsignedTx {
  from: Address
  to: Address
  value: string
  data?: HexString
  fee?: Record<string, string>
  nonce?: number
  extra?: Record<string, unknown>
}

/**
 * Parameters for sending a transaction.
 */
export interface SendParams {
  /** Recipient address */
  to: string
  /** Amount to send as a string */
  amount: string
  /** Asset identifier (token address, denom, etc.) */
  asset?: string
  /** Optional memo/message */
  memo?: string
  /** Chain-specific options */
  options?: Record<string, unknown>
}

/**
 * Function type for unsubscribing from events.
 */
export type Unsubscribe = () => void
