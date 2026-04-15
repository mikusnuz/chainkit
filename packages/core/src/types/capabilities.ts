import type { Address, Balance, HexString, TokenMetadata, Utxo, Unsubscribe, TransactionInfo } from './common.js'

/**
 * Capability for chains that support smart contracts.
 */
export interface ContractCapable {
  /**
   * Call a read-only contract method.
   * @param contractAddress - The contract address
   * @param method - The method signature or ABI-encoded call data
   * @param params - Method parameters
   * @returns The decoded return value
   */
  callContract(contractAddress: Address, method: string, params?: unknown[]): Promise<unknown>

  /**
   * Estimate gas for a contract call.
   * @param contractAddress - The contract address
   * @param method - The method signature or ABI-encoded call data
   * @param params - Method parameters
   * @returns Estimated gas as a string
   */
  estimateGas(contractAddress: Address, method: string, params?: unknown[]): Promise<string>
}

/**
 * Capability for chains that support tokens (ERC-20, SPL, etc.).
 */
export interface TokenCapable {
  /**
   * Get the balance of a specific token for an address.
   * @param address - The holder address
   * @param tokenAddress - The token contract address
   * @returns Token balance
   */
  getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance>

  /**
   * Get metadata for a token.
   * @param tokenAddress - The token contract address
   * @returns Token metadata
   */
  getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata>
}

/**
 * Capability for chains that support event subscriptions.
 */
export interface SubscriptionCapable {
  /**
   * Subscribe to new blocks.
   * @param callback - Called with the block number when a new block is produced
   * @returns Unsubscribe function
   */
  subscribeBlocks(callback: (blockNumber: number) => void): Promise<Unsubscribe>

  /**
   * Subscribe to transactions for an address.
   * @param address - The address to watch
   * @param callback - Called with transaction info when activity is detected
   * @returns Unsubscribe function
   */
  subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe>
}

/**
 * Capability for UTXO-based chains (Bitcoin, Litecoin, etc.).
 */
export interface UtxoCapable {
  /**
   * Get unspent transaction outputs for an address.
   * @param address - The address to query
   * @returns List of UTXOs
   */
  getUtxos(address: Address): Promise<Utxo[]>

  /**
   * Select UTXOs for a target amount using coin selection.
   * @param address - The address to select UTXOs from
   * @param targetAmount - The target amount as a string
   * @returns Selected UTXOs and change amount
   */
  selectUtxos(
    address: Address,
    targetAmount: string,
  ): Promise<{ utxos: Utxo[]; change: string }>
}
