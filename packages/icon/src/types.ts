/**
 * ICON transaction data for building JSON-RPC v3 transactions.
 */
export interface IconTransactionData {
  /** Sender address (hx-prefixed) */
  from: string
  /** Recipient address (hx-prefixed) */
  to: string
  /** Amount in loop (hex, e.g., "0xde0b6b3a7640000") */
  value?: string
  /** Step limit (hex) */
  stepLimit?: string
  /** Network ID (hex, e.g., "0x1" for mainnet, "0x2" for Lisbon testnet) */
  nid?: string
  /** Nonce (hex) */
  nonce?: string
  /** Transaction version (hex, "0x3" for v3) */
  version?: string
  /** Unix timestamp in microseconds (hex) */
  timestamp?: string
  /** Data type: "call" for SCORE calls, "deploy" for deploy, "message" for message */
  dataType?: 'call' | 'deploy' | 'message'
  /** Data payload */
  data?: unknown
}

/**
 * ICON SCORE call parameters.
 */
export interface ScoreCallParams {
  /** Method name */
  method: string
  /** Method parameters */
  params?: Record<string, string>
}
