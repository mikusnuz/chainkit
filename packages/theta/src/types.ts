export interface ThetaTransactionData {
  to: string
  value?: string
  data?: string
  nonce?: number
  chainId: number
  gasLimit?: string
  gasPrice?: string
}

export interface ThetaAccountResult {
  sequence: string
  coins: {
    thetawei: string
    tfuelwei: string
  }
  reserved_funds: unknown[]
  last_updated_block_height: string
  root: string
  code: string
}

export interface ThetaBlockResult {
  chain_id: string
  epoch: string
  height: string
  parent: string
  transactions_hash: string
  state_hash: string
  timestamp: string
  proposer: {
    address: string
    coins: unknown
  }
  children: string[]
  status: number
  hash: string
  transactions: ThetaBlockTransaction[]
}

export interface ThetaBlockTransaction {
  raw: {
    fee: {
      thetawei: string
      tfuelwei: string
    }
    inputs?: Array<{
      address: string
      coins: {
        thetawei: string
        tfuelwei: string
      }
      sequence: string
      signature: string
    }>
    outputs?: Array<{
      address: string
      coins: {
        thetawei: string
        tfuelwei: string
      }
    }>
  }
  type: number
  hash: string
}
