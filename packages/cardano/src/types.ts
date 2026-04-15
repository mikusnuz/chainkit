/**
 * Cardano transaction input (UTXO reference).
 */
export interface CardanoTxInput {
  /** Transaction hash of the UTXO being spent */
  txHash: string
  /** Output index within that transaction */
  outputIndex: number
}

/**
 * Cardano transaction output.
 */
export interface CardanoTxOutput {
  /** Recipient address (bech32 Shelley address) */
  address: string
  /** Amount in lovelace as a string */
  amount: string
}

/**
 * Cardano-specific transaction data for the eUTXO model.
 */
export interface CardanoTransactionData {
  /** Transaction inputs (UTXOs to spend) */
  inputs: CardanoTxInput[]
  /** Transaction outputs */
  outputs: CardanoTxOutput[]
  /** Transaction fee in lovelace as a string */
  fee: string
  /** Time-to-live (absolute slot number after which the tx is invalid) */
  ttl: number
}

/**
 * Cardano fee estimation detail.
 */
export interface CardanoFeeDetail {
  /** Minimum fee in lovelace */
  minFee: string
  /** Estimated transaction size in bytes */
  txSize: number
}
