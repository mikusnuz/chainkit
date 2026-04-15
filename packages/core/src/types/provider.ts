import type { Address, TxHash, Balance, TransactionInfo, BlockInfo, ChainInfo, HexString } from './common.js'

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

/**
 * Interface for chain-specific data provider operations.
 * Each chain adapter implements this to interact with the blockchain.
 */
export interface ChainProvider {
  /**
   * Get the balance of an address.
   * @param address - The address to query
   * @returns Balance information
   */
  getBalance(address: Address): Promise<Balance>

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
}
