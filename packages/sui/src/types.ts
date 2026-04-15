export interface SuiTransactionData {
  kind: string
  sender: string
  gasData: {
    budget: string
    price: string
    owner: string
    payment: Array<{
      objectId: string
      version: string
      digest: string
    }>
  }
}

export interface SuiFeeDetail {
  computationCost: string
  storageCost: string
  storageRebate: string
}
