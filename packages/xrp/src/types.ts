/**
 * XRP transaction data for constructing unsigned transactions.
 */
export interface XrpTransactionData {
  /** The sender account address */
  account: string
  /** The destination account address */
  destination: string
  /** Amount in drops (1 XRP = 1,000,000 drops) */
  amount: string
  /** Fee in drops */
  fee: string
  /** Account sequence number */
  sequence: number
  /** Transaction type (default: "Payment") */
  transactionType?: string
  /** Destination tag (optional) */
  destinationTag?: number
  /** Memos (optional) */
  memos?: Array<{
    memoType?: string
    memoData?: string
  }>
  /** Last ledger sequence for transaction expiration */
  lastLedgerSequence?: number
}

/**
 * XRP fee detail returned by fee estimation.
 */
export interface XrpFeeDetail {
  /** Minimum fee in drops */
  drops: string
  /** Open ledger fee in drops */
  openLedgerFee: string
}
