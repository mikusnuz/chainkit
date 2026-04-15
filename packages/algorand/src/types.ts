export interface AlgorandTransactionData {
  type: string
  from: string
  to: string
  amount: number
  fee: number
  firstRound: number
  lastRound: number
  genesisHash: string
  genesisId: string
  note?: string
}

export interface AlgorandFeeDetail {
  minFee: string
  suggestedFee: string
}
