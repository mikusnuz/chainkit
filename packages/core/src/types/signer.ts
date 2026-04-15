import type { Address, UnsignedTx, HexString } from './common.js'

/**
 * Interface for chain-specific signing operations.
 * Each chain adapter implements this to handle key derivation and transaction signing.
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
   * @param path - BIP44 derivation path (e.g., "m/44'/60'/0'/0/0")
   * @returns The derived private key as a hex string
   */
  derivePrivateKey(mnemonic: string, path: string): Promise<HexString>

  /**
   * Get the address for a given private key.
   * @param privateKey - The private key as a hex string
   * @returns The derived address
   */
  getAddress(privateKey: HexString): Address

  /**
   * Sign a transaction.
   * @param tx - The unsigned transaction to sign
   * @param privateKey - The private key to sign with
   * @returns The signed transaction as a hex string
   */
  signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString>

  /**
   * Sign an arbitrary message.
   * @param message - The message to sign (string or bytes)
   * @param privateKey - The private key to sign with
   * @returns The signature as a hex string
   */
  signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString>
}
