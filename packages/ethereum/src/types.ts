export interface EvmTransactionData {
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

export interface EvmFeeDetail {
  gasLimit: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
}
