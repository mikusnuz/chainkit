/**
 * Stacks-specific transaction data.
 */
export interface StacksTransactionData {
  /** Recipient address (SP... or ST...) */
  to: string
  /** Amount in microSTX (1 STX = 1,000,000 microSTX) */
  amount?: string
  /** Transaction memo */
  memo?: string
  /** Nonce for the sender */
  nonce?: number
  /** Fee in microSTX */
  fee?: string
  /** Network: mainnet or testnet */
  network?: 'mainnet' | 'testnet'
  /** Anchor mode */
  anchorMode?: number
  /** Post-condition mode */
  postConditionMode?: number
  /** Contract call details */
  contractCall?: {
    contractAddress: string
    contractName: string
    functionName: string
    functionArgs?: string[]
  }
}

/**
 * Stacks fee estimation detail.
 */
export interface StacksFeeDetail {
  /** Estimated fee in microSTX */
  estimatedFee: string
}
