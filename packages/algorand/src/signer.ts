import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { sha512_256 } from '@noble/hashes/sha512'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { base32 } from '@scure/base'

// @noble/ed25519 v2 requires setting the sha512 hash function
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

/**
 * Strip the '0x' prefix from a hex string if present.
 */
function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex
}

/**
 * Add the '0x' prefix to a hex string if not already present.
 */
function addHexPrefix(hex: string): string {
  return hex.startsWith('0x') ? hex : `0x${hex}`
}

/**
 * BIP44 path regex: m / purpose' / coin_type' / account' / change' (all hardened for ED25519)
 */
const BIP44_PATH_REGEX = /^m(\/\d+'?)+$/

/**
 * SLIP-0010 ED25519 master key derivation from seed.
 * Uses "ed25519 seed" as the HMAC key per SLIP-0010 spec.
 */
function slip0010MasterKey(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed)
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32),
  }
}

/**
 * SLIP-0010 ED25519 child key derivation (hardened only).
 * ED25519 only supports hardened derivation per SLIP-0010.
 */
function slip0010DeriveChild(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  // Hardened child: HMAC-SHA512(Key = chainCode, Data = 0x00 || parentKey || index)
  const data = new Uint8Array(1 + 32 + 4)
  data[0] = 0x00
  data.set(parentKey, 1)
  // index in big-endian
  data[33] = (index >>> 24) & 0xff
  data[34] = (index >>> 16) & 0xff
  data[35] = (index >>> 8) & 0xff
  data[36] = index & 0xff

  const I = hmac(sha512, parentChainCode, data)
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32),
  }
}

/**
 * Derive an ED25519 private key from a seed using SLIP-0010.
 * All path components must be hardened (indicated by ').
 */
function slip0010DerivePath(seed: Uint8Array, path: string): Uint8Array {
  if (!BIP44_PATH_REGEX.test(path)) {
    throw new ChainKitError(
      ErrorCode.INVALID_PATH,
      `Invalid derivation path: "${path}". Expected format: m/44'/283'/0'/0'/0'`,
    )
  }

  const segments = path.split('/').slice(1) // Remove "m"
  let { key, chainCode } = slip0010MasterKey(seed)

  for (const segment of segments) {
    const hardened = segment.endsWith("'")
    const indexStr = hardened ? segment.slice(0, -1) : segment
    const index = parseInt(indexStr, 10)

    if (isNaN(index)) {
      throw new ChainKitError(ErrorCode.INVALID_PATH, `Invalid path segment: ${segment}`)
    }

    // SLIP-0010 ED25519 only supports hardened derivation
    if (!hardened) {
      throw new ChainKitError(
        ErrorCode.INVALID_PATH,
        `ED25519 (SLIP-0010) only supports hardened derivation. Segment "${segment}" must be hardened (add ').`,
      )
    }

    const childIndex = index + 0x80000000
    const child = slip0010DeriveChild(key, chainCode, childIndex)
    key = child.key
    chainCode = child.chainCode
  }

  return key
}

/**
 * Encode an ED25519 public key into an Algorand address.
 * Address = base32(pubkey(32 bytes) + checksum(4 bytes)), no padding, uppercase.
 * Checksum = last 4 bytes of SHA-512/256(pubkey).
 */
function encodeAlgorandAddress(publicKey: Uint8Array): string {
  const hash = sha512_256(publicKey)
  const checksum = hash.slice(hash.length - 4)

  // Concatenate pubkey + checksum (36 bytes)
  const addressBytes = new Uint8Array(36)
  addressBytes.set(publicKey, 0)
  addressBytes.set(checksum, 32)

  // Base32 encode without padding, uppercase
  const encoded = base32.encode(addressBytes)
  return encoded.toUpperCase().replace(/=+$/, '')
}

/**
 * Decode an Algorand address back to public key bytes.
 * Validates the checksum.
 */
function decodeAlgorandAddress(address: string): Uint8Array {
  // Pad to multiple of 8 for base32 decoding
  const padded = address + '='.repeat((8 - (address.length % 8)) % 8)
  const decoded = base32.decode(padded)

  if (decoded.length !== 36) {
    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      `Invalid Algorand address: decoded length ${decoded.length}, expected 36`,
    )
  }

  const publicKey = decoded.slice(0, 32)
  const checksum = decoded.slice(32)

  // Verify checksum
  const hash = sha512_256(publicKey)
  const expectedChecksum = hash.slice(hash.length - 4)

  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) {
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        'Invalid Algorand address: checksum mismatch',
      )
    }
  }

  return publicKey
}

/**
 * Algorand signer implementing the ChainSigner interface.
 * Uses ED25519 keys with SLIP-0010 derivation and base32 addresses.
 */
export class AlgorandSigner implements ChainSigner {
  /**
   * Generate a new BIP39 mnemonic phrase.
   */
  generateMnemonic(strength?: number): string {
    return generateMnemonic(strength)
  }

  /**
   * Validate a BIP39 mnemonic phrase.
   */
  validateMnemonic(mnemonic: string): boolean {
    return validateMnemonic(mnemonic)
  }

  /**
   * Derive an ED25519 private key from a mnemonic using SLIP-0010.
   * Returns a '0x'-prefixed hex string of the 32-byte seed (private key).
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKey = slip0010DerivePath(seed, path)
    return addHexPrefix(bytesToHex(privateKey))
  }

  /**
   * Get the Algorand address for a given private key.
   * Algorand address = base32(ED25519 pubkey + SHA-512/256 checksum last 4 bytes), uppercase, no padding.
   */
  getAddress(privateKey: HexString): Address {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get ED25519 public key (32 bytes)
    const publicKey = ed25519.getPublicKey(pkBytes)

    return encodeAlgorandAddress(publicKey)
  }

  /**
   * Sign an Algorand transaction.
   * The transaction data is expected to be serialized in tx.data as a hex string.
   * Returns the ED25519 signature as a hex string.
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // The transaction message to sign should be in tx.data (hex-encoded serialized message)
    if (!tx.data) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Transaction data (serialized message) is required for Algorand signing',
      )
    }

    const messageBytes = hexToBytes(stripHexPrefix(tx.data as string))

    // Sign with ED25519
    const signature = ed25519.sign(messageBytes, pkBytes)

    return addHexPrefix(bytesToHex(signature))
  }

  /**
   * Sign an arbitrary message with ED25519.
   * Returns the 64-byte signature as a hex string.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    const signature = ed25519.sign(msgBytes, pkBytes)

    return addHexPrefix(bytesToHex(signature))
  }
}

export { encodeAlgorandAddress, decodeAlgorandAddress }
