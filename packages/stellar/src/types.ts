/**
 * Stellar transaction data structure.
 */
export interface StellarTransactionData {
  /** Source account address (G... StrKey) */
  source: string
  /** Base fee in stroops (1 XLM = 10^7 stroops) */
  fee: string
  /** Sequence number for the source account */
  seqNum: string
  /** List of operations to include in the transaction */
  operations: Array<{
    type: string
    destination?: string
    amount?: string
    asset?: { code: string; issuer?: string }
    [key: string]: unknown
  }>
  /** Optional memo */
  memo?: { type: string; value?: string }
  /** Optional time bounds */
  timeBounds?: { minTime: number; maxTime: number }
  /** Network passphrase (e.g., "Public Global Stellar Network ; September 2015") */
  networkPassphrase?: string
}

/**
 * Stellar fee detail.
 */
export interface StellarFeeDetail {
  /** Base fee per operation in stroops */
  baseFee: string
}
