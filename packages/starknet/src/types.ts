export interface StarknetTransactionData {
  contractAddress: string
  entrypoint: string
  calldata: string[]
  nonce?: number
  maxFee?: string
  version?: string
  chainId?: string
}

export interface StarknetFeeDetail {
  gasConsumed: string
  gasPrice: string
  dataGasConsumed: string
}
