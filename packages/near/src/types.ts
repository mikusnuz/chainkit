export interface NearTransactionData {
  signerId: string
  receiverId: string
  actions: Array<{ type: string; params: unknown }>
  nonce: number
  blockHash: string
}

export interface NearFeeDetail {
  gasBurnt: string
  tokensBurnt: string
}
