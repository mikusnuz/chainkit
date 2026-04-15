export interface ZkspaceTransactionData {
  to: string
  value?: string
  data?: string
  nonce?: number
  chainId: number
  gasLimit?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  gasPrice?: string
  type?: number
}

export interface ZkspaceFeeDetail {
  l2Fee: string
  l1GasFee: string
}
