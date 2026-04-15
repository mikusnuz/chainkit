export interface PolkadotTransactionData {
  method: string          // e.g., 'balances.transfer'
  args: unknown[]
  era?: { period: number; current: number }
  nonce: number
  tip?: string
  specVersion: number
  transactionVersion: number
  genesisHash: string
  blockHash: string
}

export interface PolkadotFeeDetail {
  partialFee: string
  weight: string
}
