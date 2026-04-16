import type { ChainSigner, ChainProvider, RpcManagerConfig, UnsignedTx, TransactionInfo, WaitForTransactionOptions } from '@chainkit/core'

/**
 * A chain definition that provides a Signer class and a Provider class.
 * Each chain package exports a default definition following this shape.
 */
export interface ChainDefinition {
  name: string
  Signer: new () => ChainSigner
  Provider: new (config: RpcManagerConfig) => ChainProvider
}

/**
 * Configuration for a single chain within the client.
 */
export interface ChainConfig {
  /** The chain definition (e.g., `ethereum` from @chainkit/ethereum) */
  chain: ChainDefinition
  /** RPC endpoint URLs */
  rpcs: string[]
  /** RPC endpoint selection strategy */
  strategy?: 'failover' | 'round-robin' | 'fastest'
  /** Request timeout in milliseconds */
  timeout?: number
  /** Number of retries per endpoint */
  retries?: number
  /** Private key for signing (hex string) */
  privateKey?: string
  /** BIP39 mnemonic for key derivation */
  mnemonic?: string
  /** BIP44 HD derivation path */
  hdPath?: string
}

/**
 * Map of chain name to chain config.
 */
export type ChainsConfig = Record<string, ChainConfig>

/**
 * A read-only chain instance that can query but not sign/send.
 */
export interface ReadOnlyChainInstance {
  getBalance: ChainProvider['getBalance']
  getTransaction: ChainProvider['getTransaction']
  getBlock: ChainProvider['getBlock']
  estimateFee: ChainProvider['estimateFee']
  getChainInfo: ChainProvider['getChainInfo']
  waitForTransaction(hash: string, options?: WaitForTransactionOptions): Promise<TransactionInfo>
  readonly provider: ChainProvider
}

/**
 * Parameters for send() and prepareTransaction().
 */
export interface SendParams {
  /** Recipient address */
  to: string
  /** Amount to send as a string */
  amount: string
  /** Optional memo/message */
  memo?: string
  /** Optional data payload */
  data?: unknown
  /** Chain-specific options (overrides for fee, nonce, etc.) */
  options?: Record<string, unknown>
}

/**
 * A full chain instance that can query, sign, and send transactions.
 */
export interface FullChainInstance extends ReadOnlyChainInstance {
  send(params: SendParams): Promise<string>
  prepareTransaction(params: SendParams): Promise<UnsignedTx>
  waitForTransaction(hash: string, options?: WaitForTransactionOptions): Promise<TransactionInfo>
  signTransaction: ChainSigner['signTransaction']
  signMessage: ChainSigner['signMessage']
  getAddress(): string
  readonly signer: ChainSigner
}
