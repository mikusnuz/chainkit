export interface CosmosTransactionData {
  messages: unknown[]
  fee: {
    amount: Array<{ denom: string; amount: string }>
    gas: string
  }
  memo?: string
  chainId: string
  accountNumber: number
  sequence: number
}

export interface CosmosFeeDetail {
  gasWanted: string
  gasPrice: string
  denom: string
}
