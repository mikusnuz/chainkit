export interface AptosTransactionData {
  sender: string
  sequenceNumber: string
  maxGasAmount: string
  gasUnitPrice: string
  expirationTimestampSecs: string
  payload: unknown
  chainId: number
}

export interface AptosFeeDetail {
  gasUnitPrice: string
  maxGasAmount: string
}
