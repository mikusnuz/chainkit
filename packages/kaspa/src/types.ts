export interface KaspaTransactionData {
  inputs: Array<{ txHash: string; outputIndex: number; value: string; script: string }>
  outputs: Array<{ address: string; value: string }>
}

export interface KaspaFeeDetail {
  mass: string
  feePerMass: string
}
