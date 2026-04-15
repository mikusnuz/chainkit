/**
 * IOTA transaction essence data for building transactions.
 */
export interface IotaTransactionEssence {
  /** Network ID */
  networkId: string
  /** Inputs consumed by this transaction */
  inputs: Array<{
    type: number
    transactionId: string
    transactionOutputIndex: number
  }>
  /** Outputs created by this transaction */
  outputs: Array<{
    type: number
    amount: string
    unlockConditions: Array<{
      type: number
      address: {
        type: number
        pubKeyHash: string
      }
    }>
  }>
  /** Optional payload (e.g., tagged data) */
  payload?: {
    type: number
    tag: string
    data: string
  }
}

/**
 * IOTA output details as returned by the node API.
 */
export interface IotaOutputResponse {
  metadata: {
    blockId: string
    transactionId: string
    outputIndex: number
    isSpent: boolean
    milestoneIndexBooked: number
    milestoneTimestampBooked: number
    ledgerIndex: number
  }
  output: {
    type: number
    amount: string
    unlockConditions: Array<{
      type: number
      address?: {
        type: number
        pubKeyHash: string
      }
    }>
  }
}

/**
 * IOTA basic output query response from the indexer API.
 */
export interface IotaOutputsResponse {
  ledgerIndex: number
  cursor?: string
  items: string[]
}

/**
 * IOTA block info from the node API.
 */
export interface IotaBlockResponse {
  protocolVersion: number
  parents: string[]
  payload?: {
    type: number
    essence?: {
      type: number
      networkId: string
      inputs: Array<{
        type: number
        transactionId: string
        transactionOutputIndex: number
      }>
      outputs: Array<{
        type: number
        amount: string
        unlockConditions: unknown[]
      }>
    }
  }
  nonce: string
}

/**
 * IOTA node info response.
 */
export interface IotaNodeInfoResponse {
  name: string
  version: string
  status: {
    isHealthy: boolean
    latestMilestone: {
      index: number
      timestamp: number
      milestoneId: string
    }
    confirmedMilestone: {
      index: number
      timestamp: number
      milestoneId: string
    }
  }
  protocol: {
    version: number
    networkName: string
    bech32Hrp: string
    minPowScore: number
    belowMaxDepth: number
    rentStructure: {
      vByteCost: number
      vByteFactorKey: number
      vByteFactorData: number
    }
    tokenSupply: string
  }
  baseToken: {
    name: string
    tickerSymbol: string
    unit: string
    subunit: string
    decimals: number
  }
}
