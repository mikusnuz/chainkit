/**
 * MultiversX transaction data structure.
 * Represents the fields needed for a MultiversX transaction.
 */
export interface MultiversXTransactionData {
  nonce: number
  value: string
  receiver: string
  sender: string
  gasPrice: number
  gasLimit: number
  data?: string
  chainID: string
  version: number
  options?: number
}

/**
 * MultiversX fee detail.
 */
export interface MultiversXFeeDetail {
  gasPrice: number
  gasLimit: number
  dataMovementGas: number
  dataProcessingGas: number
}

/**
 * MultiversX ESDT token transfer data.
 */
export interface EsdtTransferData {
  tokenIdentifier: string
  amount: string
  nonce?: number
}
