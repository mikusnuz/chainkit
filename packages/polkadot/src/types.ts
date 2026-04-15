export interface PolkadotTransactionData {
  method: string          // e.g., 'balances.transferKeepAlive'
  args: unknown[]
  era?: { period: number; current: number }
  nonce: number
  tip?: string | bigint
  specVersion: number
  transactionVersion: number
  genesisHash: string
  blockHash: string
}

/**
 * Extra fields for Polkadot UnsignedTx.extra.
 * Pass these via UnsignedTx.extra when calling signTransaction.
 */
export interface PolkadotTxExtra {
  /** Runtime spec version (u32) */
  specVersion: number
  /** Runtime transaction version (u32) */
  transactionVersion: number
  /** Genesis hash (0x-prefixed 32-byte hex) */
  genesisHash: string
  /** Block hash for mortal era or genesis hash for immortal (0x-prefixed 32-byte hex) */
  blockHash: string
  /** Optional tip in planck (defaults to 0) */
  tip?: string | bigint
  /** Optional era: immortal (default) or mortal with period and current block */
  era?: { period: number; current: number }
  /** Optional pallet index for Balances (defaults to 5) */
  palletIndex?: number
  /** Optional call index for transferKeepAlive (defaults to 3) */
  callIndex?: number
}

export interface PolkadotFeeDetail {
  partialFee: string
  weight: string
}
