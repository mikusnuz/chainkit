import type { Address, TxHash, Balance, TransactionInfo, BlockInfo, ChainInfo, HexString } from './common.js'
import type { WaitForTransactionOptions } from '../utils/wait-for-tx.js'

/**
 * Fee estimation result.
 */
export interface FeeEstimate {
  /** Slow fee (lower priority) */
  slow: string
  /** Average fee (normal priority) */
  average: string
  /** Fast fee (high priority) */
  fast: string
  /** Unit of the fee (e.g., "gwei", "sat/vB") */
  unit: string
}

// ─── Endpoint & Provider Configuration ───

/**
 * Strategy for selecting endpoints when multiple are configured.
 */
export type EndpointStrategy = 'failover' | 'round-robin' | 'fastest'

/**
 * Configuration for a single endpoint.
 */
export interface EndpointConfig {
  /** Endpoint URL */
  url: string
  /** Optional custom headers for this endpoint */
  headers?: Record<string, string>
}

/**
 * Flexible endpoint input: a single URL string, a config object, or arrays of either.
 */
export type EndpointInput = string | EndpointConfig | string[] | EndpointConfig[]

/**
 * Unified provider configuration for all chain adapters.
 * Replaces ad-hoc constructor configs with a standard shape.
 */
export interface ProviderConfig {
  /** Endpoint(s) to connect to. Can be a flat input or categorized by type. */
  endpoints: EndpointInput | {
    rpc?: EndpointInput
    rest?: EndpointInput
    lcd?: EndpointInput
    indexer?: EndpointInput
    mirror?: EndpointInput
  }
  /** Strategy for endpoint selection when multiple endpoints are provided */
  strategy?: EndpointStrategy
  /** Request timeout in milliseconds */
  timeoutMs?: number
  /** Number of retries before giving up */
  retries?: number
  /** Transport protocol for connecting to the endpoint */
  transport?: 'http' | 'ws' | 'auto'
}

/**
 * Interface for chain-specific data provider operations.
 * Each chain adapter implements this to interact with the blockchain.
 */
export interface ChainProvider {
  /**
   * Get the balance of an address (primary native token).
   * @param address - The address to query
   * @returns Balance information
   */
  getBalance(address: Address): Promise<Balance>

  /**
   * Get all native token balances for an address.
   * Useful for dual-token chains (e.g., EOS CPU/NET/RAM, Cosmos denoms).
   * Optional: not all chains have multiple native tokens.
   * @param address - The address to query
   * @returns Array of balance information
   */
  getNativeBalances?(address: Address): Promise<Balance[]>

  /**
   * Get transaction details by hash.
   * @param hash - The transaction hash
   * @returns Transaction information or null if not found
   */
  getTransaction(hash: TxHash): Promise<TransactionInfo | null>

  /**
   * Get block details by number or hash.
   * @param hashOrNumber - Block hash or block number
   * @returns Block information or null if not found
   */
  getBlock(hashOrNumber: string | number): Promise<BlockInfo | null>

  /**
   * Get the nonce or sequence number for an address.
   * The meaning varies by chain: Ethereum uses transaction count,
   * XRP uses account sequence, Cosmos uses account sequence, etc.
   * @param address - The address to query
   * @returns The nonce/sequence as a string or number
   */
  getNonce(address: Address): Promise<string | number>

  /**
   * Estimate transaction fees.
   * @returns Fee estimates for different priority levels
   */
  estimateFee(): Promise<FeeEstimate>

  /**
   * Broadcast a signed transaction to the network.
   * @param signedTx - The signed transaction as a hex string
   * @returns The transaction hash
   */
  broadcastTransaction(signedTx: HexString): Promise<TxHash>

  /**
   * Get chain/network information.
   * @returns Chain metadata
   */
  getChainInfo(): Promise<ChainInfo>

  /**
   * Wait for a transaction to be confirmed on-chain.
   * Polls getTransaction until the status is 'confirmed' or 'failed',
   * or until the timeout is reached.
   *
   * @param hash - The transaction hash to watch
   * @param options - Polling configuration (timeout, interval, confirmations)
   * @returns The confirmed TransactionInfo
   * @throws ChainKitError with TIMEOUT code if the timeout is exceeded
   * @throws ChainKitError with TRANSACTION_FAILED code if the transaction fails
   */
  waitForTransaction?(hash: string, options?: WaitForTransactionOptions): Promise<TransactionInfo>
}
