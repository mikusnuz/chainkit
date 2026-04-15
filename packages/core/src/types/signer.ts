import type { Address, UnsignedTx, HexString } from './common.js'

/**
 * Parameters for signing a transaction.
 */
export interface SignTransactionParams {
  /** The private key to sign with */
  privateKey: string
  /** The unsigned transaction to sign */
  tx: UnsignedTx
  /** Signing options */
  options?: {
    /** Whether to return the full broadcast-ready tx or just the signature */
    encoding?: 'broadcast' | 'signature-only'
  }
}

/**
 * Parameters for signing an arbitrary message.
 */
export interface SignMessageParams {
  /** The message to sign (string or bytes) */
  message: string | Uint8Array
  /** The private key to sign with */
  privateKey: string
}

/**
 * Interface for chain-specific signing operations.
 * Each chain adapter implements this to handle key derivation and transaction signing.
 *
 * Note: signTransaction uses a single params object. signMessage accepts either
 * params object or direct arguments for backward compatibility. derivePrivateKey
 * may return synchronously or asynchronously depending on the chain.
 */
export interface ChainSigner {
  /**
   * Generate a new BIP39 mnemonic phrase.
   * @param strength - Mnemonic strength in bits (128 = 12 words, 256 = 24 words)
   * @returns The generated mnemonic phrase
   */
  generateMnemonic(strength?: number): string

  /**
   * Validate a BIP39 mnemonic phrase.
   * @param mnemonic - The mnemonic phrase to validate
   * @returns True if the mnemonic is valid
   */
  validateMnemonic(mnemonic: string): boolean

  /**
   * Derive a private key from a mnemonic using BIP44 path.
   * @param mnemonic - The mnemonic phrase
   * @param hdPath - BIP44 derivation path (e.g., "m/44'/60'/0'/0/0")
   * @returns The derived private key as a string (sync or async)
   */
  derivePrivateKey(mnemonic: string, hdPath: string): Promise<string> | string

  /**
   * Get the address for a given private key.
   * @param privateKey - The private key
   * @returns The derived address
   */
  getAddress(privateKey: string): string

  /**
   * Sign a transaction using a params object.
   * @param params - The signing parameters
   * @returns The signed transaction as a string
   */
  signTransaction(params: SignTransactionParams): Promise<string>

  /**
   * Sign an arbitrary message.
   * @param params - The signing parameters
   * @returns The signature as a string (sync or async)
   */
  signMessage(params: SignMessageParams): Promise<string> | string

  /**
   * Validate whether a string is a valid address for this chain.
   * @param address - The address string to validate
   * @returns True if the address is valid for this chain
   */
  validateAddress(address: string): boolean
}

/**
 * @deprecated Use ChainSigner instead. Kept for backward compatibility with existing chain adapters.
 * The legacy interface uses positional arguments for signTransaction and signMessage.
 */
export interface LegacyChainSigner {
  generateMnemonic(strength?: number): string
  validateMnemonic(mnemonic: string): boolean
  derivePrivateKey(mnemonic: string, path: string): Promise<HexString>
  getAddress(privateKey: HexString): Address
  signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString>
  signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString>
}
