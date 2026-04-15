export interface SolTransactionData {
  recentBlockhash: string
  instructions: Array<{
    programId: string
    keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>
    data: string
  }>
  feePayer: string
}

export interface SolFeeDetail {
  computeUnits: number
  priorityFee: string
  baseFee: string
}
