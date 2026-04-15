import {
  generateMnemonic as _generateMnemonic,
  validateMnemonic as _validateMnemonic,
  mnemonicToSeed as _mnemonicToSeed,
  mnemonicToSeedSync as _mnemonicToSeedSync,
} from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { ChainKitError, ErrorCode } from '../types/errors.js'

/**
 * Generate a new BIP39 mnemonic phrase (English wordlist).
 * @param strength - Mnemonic strength in bits. 128 = 12 words, 256 = 24 words. Default: 128.
 * @returns The generated mnemonic phrase as a space-separated string.
 */
export function generateMnemonic(strength: number = 128): string {
  if (strength !== 128 && strength !== 160 && strength !== 192 && strength !== 224 && strength !== 256) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid mnemonic strength: ${strength}. Must be 128, 160, 192, 224, or 256.`,
    )
  }
  return _generateMnemonic(wordlist, strength)
}

/**
 * Validate a BIP39 mnemonic phrase (English wordlist).
 * @param mnemonic - The mnemonic phrase to validate.
 * @returns True if the mnemonic is valid.
 */
export function validateMnemonic(mnemonic: string): boolean {
  return _validateMnemonic(mnemonic, wordlist)
}

/**
 * Derive a 64-byte seed from a BIP39 mnemonic (async version using PBKDF2).
 * @param mnemonic - The mnemonic phrase.
 * @param passphrase - Optional passphrase for additional protection.
 * @returns 64-byte seed as Uint8Array.
 */
export async function mnemonicToSeed(mnemonic: string, passphrase?: string): Promise<Uint8Array> {
  if (!validateMnemonic(mnemonic)) {
    throw new ChainKitError(ErrorCode.INVALID_MNEMONIC, 'Invalid mnemonic phrase')
  }
  return _mnemonicToSeed(mnemonic, passphrase)
}

/**
 * Derive a 64-byte seed from a BIP39 mnemonic (sync version using PBKDF2).
 * @param mnemonic - The mnemonic phrase.
 * @param passphrase - Optional passphrase for additional protection.
 * @returns 64-byte seed as Uint8Array.
 */
export function mnemonicToSeedSync(mnemonic: string, passphrase?: string): Uint8Array {
  if (!validateMnemonic(mnemonic)) {
    throw new ChainKitError(ErrorCode.INVALID_MNEMONIC, 'Invalid mnemonic phrase')
  }
  return _mnemonicToSeedSync(mnemonic, passphrase)
}
