export interface TronTransactionData {
  to: string
  amount: string // in SUN (1 TRX = 1,000,000 SUN)
  tokenId?: string
  data?: string
}

export interface TronFeeDetail {
  energy: number
  bandwidth: number
  sunCost: string
}
