export interface TonTransactionData {
  to: string
  amount: string // in nanoton
  payload?: string
  bounce?: boolean
}

export interface TonFeeDetail {
  gasFee: string
  storageFee: string
  forwardFee: string
}
