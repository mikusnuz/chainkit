/**
 * Flow transaction data structure for Cadence transactions.
 */
export interface FlowTransactionData {
  /** Cadence script for the transaction */
  script: string
  /** Arguments for the Cadence script (JSON-Cadence encoded) */
  arguments: Array<{ type: string; value: string }>
  /** Reference block ID (hex string) */
  referenceBlockId: string
  /** Gas limit for the transaction */
  gasLimit: number
  /** Payer account address */
  payer: string
  /** Proposer key information */
  proposalKey: {
    address: string
    keyIndex: number
    sequenceNumber: number
  }
  /** Authorizer addresses */
  authorizers: string[]
}

/**
 * Flow fee detail.
 */
export interface FlowFeeDetail {
  /** Inclusion effort (compute cost) */
  inclusionEffort: string
  /** Execution effort */
  executionEffort: string
}
