export interface MinaTransactionData {
  from: string
  to: string
  amount: string
  fee: string
  nonce: number
  memo?: string
  validUntil?: number
}

export interface MinaSignature {
  field: string
  scalar: string
}
