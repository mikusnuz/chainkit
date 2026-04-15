import { HDKey } from '@scure/bip32'
import { bytesToHex } from '@noble/hashes/utils'
import { ChainKitError, ErrorCode } from '../types/errors.js'

/**
 * BIP44 path regex: m / purpose' / coin_type' / account' / change / address_index
 * Each component can optionally have a ' (hardened) suffix.
 */
const BIP44_PATH_REGEX = /^m(\/\d+'?)+$/

/**
 * Validate a BIP32/44 derivation path.
 */
function validatePath(path: string): void {
  if (!BIP44_PATH_REGEX.test(path)) {
    throw new ChainKitError(
      ErrorCode.INVALID_PATH,
      `Invalid derivation path: "${path}". Expected format: m/44'/60'/0'/0/0`,
    )
  }
}

/**
 * Derive a private key from a seed using a BIP32/44 derivation path.
 * @param seed - The 64-byte seed (from mnemonicToSeed).
 * @param path - BIP32/44 derivation path (e.g., "m/44'/60'/0'/0/0").
 * @returns The derived private key as a hex string (without 0x prefix).
 */
export function derivePath(seed: Uint8Array, path: string): string {
  validatePath(path)

  const master = HDKey.fromMasterSeed(seed)
  const derived = master.derive(path)

  if (!derived.privateKey) {
    throw new ChainKitError(ErrorCode.INVALID_PATH, 'Derivation did not produce a private key')
  }

  return bytesToHex(derived.privateKey)
}

/**
 * Derive a public key from a seed using a BIP32/44 derivation path.
 * @param seed - The 64-byte seed (from mnemonicToSeed).
 * @param path - BIP32/44 derivation path (e.g., "m/44'/60'/0'/0/0").
 * @returns The derived compressed public key as a hex string (without 0x prefix).
 */
export function derivePublicKey(seed: Uint8Array, path: string): string {
  validatePath(path)

  const master = HDKey.fromMasterSeed(seed)
  const derived = master.derive(path)

  if (!derived.publicKey) {
    throw new ChainKitError(ErrorCode.INVALID_PATH, 'Derivation did not produce a public key')
  }

  return bytesToHex(derived.publicKey)
}
