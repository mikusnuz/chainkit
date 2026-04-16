/**
 * Error codes for ChainKit operations.
 */
export enum ErrorCode {
  /** Unknown or unexpected error */
  UNKNOWN = 'UNKNOWN',
  /** Network/connection error */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** Request timed out */
  TIMEOUT = 'TIMEOUT',
  /** Invalid parameters provided */
  INVALID_PARAMS = 'INVALID_PARAMS',
  /** Invalid address format */
  INVALID_ADDRESS = 'INVALID_ADDRESS',
  /** Invalid mnemonic phrase */
  INVALID_MNEMONIC = 'INVALID_MNEMONIC',
  /** Invalid derivation path */
  INVALID_PATH = 'INVALID_PATH',
  /** Invalid private key */
  INVALID_PRIVATE_KEY = 'INVALID_PRIVATE_KEY',
  /** Transaction failed */
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  /** Insufficient balance */
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  /** All RPC endpoints failed */
  RPC_ALL_FAILED = 'RPC_ALL_FAILED',
  /** RPC returned an error response */
  RPC_ERROR = 'RPC_ERROR',
  /** RPC returned an invalid JSON-RPC response */
  RPC_INVALID_RESPONSE = 'RPC_INVALID_RESPONSE',
  /** Chain/network not supported */
  UNSUPPORTED_CHAIN = 'UNSUPPORTED_CHAIN',
  /** Feature not supported by the chain adapter */
  UNSUPPORTED_FEATURE = 'UNSUPPORTED_FEATURE',
  /** Signing operation failed */
  SIGNING_FAILED = 'SIGNING_FAILED',
}

/**
 * Base error class for all ChainKit errors.
 * Provides structured error information including error code and optional context.
 */
export class ChainKitError extends Error {
  /** Machine-readable error code */
  readonly code: ErrorCode
  /** Optional context with additional error details */
  readonly context?: Record<string, unknown>

  constructor(code: ErrorCode, message: string, context?: Record<string, unknown>) {
    super(message)
    this.name = 'ChainKitError'
    this.code = code
    this.context = context

    // Ensure correct prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
