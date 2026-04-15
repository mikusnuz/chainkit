/**
 * ICP transaction data for constructing unsigned transactions.
 */
export interface IcpTransactionData {
  /** Recipient account identifier (hex) or principal ID */
  to: string
  /** Amount in e8s (1 ICP = 100_000_000 e8s) */
  amount: string
  /** Optional memo (u64 as string) */
  memo?: string
  /** Fee in e8s (default: 10000) */
  fee?: string
}

/**
 * ICP fee detail.
 */
export interface IcpFeeDetail {
  /** Fee in e8s */
  fee: string
}
