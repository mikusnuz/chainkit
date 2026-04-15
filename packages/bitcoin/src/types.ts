export interface BtcTransactionData {
  inputs: Array<{ txHash: string; outputIndex: number; value: string; script: string }>
  outputs: Array<{ address: string; value: string }>
  feeRate?: string // sat/vByte
}

export interface BtcFeeDetail {
  satPerVByte: string
  estimatedSize: number
}
