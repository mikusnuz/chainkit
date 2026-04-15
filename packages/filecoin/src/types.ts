export interface FilecoinTransactionData {
  to: string
  from: string
  value: string
  method: number
  nonce: number
  gasLimit: string
  gasFeeCap: string
  gasPremium: string
}

export interface FilecoinFeeDetail {
  gasLimit: string
  gasFeeCap: string
  gasPremium: string
}
