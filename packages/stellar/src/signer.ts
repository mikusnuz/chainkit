import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx } from '@chainkit/core'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
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
 * BIP44 path regex: m / purpose' / coin_type' / account' (all hardened for ED25519)
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
      `Invalid derivation path: "${path}". Expected format: m/44'/148'/0'`,
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

// ---- StrKey encoding ----

/**
 * CRC16-XMODEM checksum used by Stellar StrKey encoding.
 */
function crc16xmodem(data: Uint8Array): Uint8Array {
  let crc = 0x0000
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff
      } else {
        crc = (crc << 1) & 0xffff
      }
    }
  }
  // Little-endian
  return new Uint8Array([crc & 0xff, (crc >> 8) & 0xff])
}

/**
 * Encode a raw public key to Stellar StrKey format (G... address).
 * Format: version_byte (0x30 for ed25519 public key) + 32-byte key + 2-byte CRC16 checksum
 * Then base32 encode the result.
 */
export function encodeStrKey(publicKey: Uint8Array, versionByte: number = 0x30): string {
  const payload = new Uint8Array(1 + publicKey.length)
  payload[0] = versionByte
  payload.set(publicKey, 1)

  const checksum = crc16xmodem(payload)
  const full = new Uint8Array(payload.length + 2)
  full.set(payload)
  full.set(checksum, payload.length)

  return base32.encode(full)
}

/**
 * Decode a Stellar StrKey address to raw bytes.
 * Returns the 32-byte public key after verifying version byte and checksum.
 */
export function decodeStrKey(strKey: string): { versionByte: number; key: Uint8Array } {
  const decoded = base32.decode(strKey)

  if (decoded.length !== 35) {
    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      `Invalid StrKey length: expected 35 bytes, got ${decoded.length}`,
    )
  }

  const versionByte = decoded[0]
  const key = decoded.slice(1, 33)
  const checksum = decoded.slice(33)

  // Verify checksum
  const payload = decoded.slice(0, 33)
  const expectedChecksum = crc16xmodem(payload)

  if (checksum[0] !== expectedChecksum[0] || checksum[1] !== expectedChecksum[1]) {
    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      'Invalid StrKey checksum',
    )
  }

  return { versionByte, key }
}

/**
 * Encode a raw secret key to Stellar StrKey format (S... secret).
 * Version byte for ed25519 secret key is 0x90 (18 << 3).
 */
export function encodeSecretStrKey(secretKey: Uint8Array): string {
  return encodeStrKey(secretKey, 0x90)
}

/**
 * Stellar signer implementing the ChainSigner interface.
 * Uses ED25519 keys with SLIP-0010 derivation and StrKey-encoded addresses.
 *
 * HD Path: m/44'/148'/0' (BIP44 coin type 148 for Stellar)
 * Address format: StrKey (base32 with version byte + CRC16 checksum)
 *   - Public keys start with 'G'
 *   - Secret keys start with 'S'
 *
 * Also compatible with PI Network (same key format and derivation).
 */
export class StellarSigner implements ChainSigner {
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
   * Get the Stellar address (StrKey G... format) for a given private key.
   * The address is a base32-encoded ED25519 public key with version byte 0x30
   * and a CRC16-XMODEM checksum.
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

    // Encode as StrKey G... address
    return encodeStrKey(publicKey)
  }

  /**
   * Sign a Stellar transaction.
   * The transaction data is expected to be serialized in tx.data as a hex string.
   * Returns the ED25519 signature as a hex string.
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // The transaction envelope hash to sign should be in tx.data (hex-encoded)
    if (!tx.data) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Transaction data (serialized transaction hash) is required for Stellar signing',
      )
    }

    const messageBytes = hexToBytes(stripHexPrefix(tx.data))

    // Sign with ED25519
    const signature = ed25519.sign(messageBytes, pkBytes)

    return addHexPrefix(bytesToHex(signature))
  }

  /**
   * Sign an arbitrary message with ED25519.
   * Returns the 64-byte signature as a hex string.
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
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
