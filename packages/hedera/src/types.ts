export interface HederaTransactionData {
  /** The account ID or alias sending the transaction */
  from: string
  /** The account ID or alias receiving the transaction */
  to: string
  /** Amount in tinybar as a string */
  amount: string
  /** Optional memo for the transaction */
  memo?: string
  /** Transaction valid start timestamp (seconds.nanos) */
  validStart?: string
  /** Node account ID to submit to */
  nodeAccountId?: string
}

export interface HederaFeeDetail {
  /** Gas cost for smart contract operations */
  gas: string
  /** Maximum fee the sender is willing to pay (in tinybar) */
  maxFee: string
}
