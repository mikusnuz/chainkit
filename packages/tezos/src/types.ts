export interface TezosTransactionData {
  branch: string
  contents: Array<{
    kind: string
    source: string
    destination: string
    amount: string
    fee: string
    gas_limit: string
    storage_limit: string
    counter: string
  }>
}

export interface TezosFeeDetail {
  gasLimit: number
  storageLimit: number
  fee: string
}
