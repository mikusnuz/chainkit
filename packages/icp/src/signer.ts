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
import { sha224 } from '@noble/hashes/sha256'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

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
 * BIP44 path regex for SLIP-0010 ED25519 (all segments must be hardened).
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
 */
function slip0010DeriveChild(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  const data = new Uint8Array(1 + 32 + 4)
  data[0] = 0x00
  data.set(parentKey, 1)
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
      `Invalid derivation path: "${path}". Expected format: m/44'/223'/0'/0'/0'`,
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
 * DER OID prefix for ED25519 public keys.
 * This is the DER encoding prefix: 30 2a 30 05 06 03 2b 65 70 03 21 00
 * ASN.1: SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING <pubkey> }
 */
const DER_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

/**
 * DER-encode an ED25519 public key (32 bytes -> 44 bytes).
 */
export function derEncodePublicKey(publicKey: Uint8Array): Uint8Array {
  const der = new Uint8Array(DER_PREFIX.length + publicKey.length)
  der.set(DER_PREFIX)
  der.set(publicKey, DER_PREFIX.length)
  return der
}

/**
 * Derive a self-authenticating Principal from an ED25519 public key.
 *
 * Steps:
 * 1. DER-encode the public key
 * 2. SHA-224 hash the DER-encoded key
 * 3. Append 0x02 suffix byte (self-authenticating principal type)
 *
 * @returns 29-byte principal (28 bytes hash + 1 byte type suffix)
 */
export function derivePrincipal(publicKey: Uint8Array): Uint8Array {
  const derKey = derEncodePublicKey(publicKey)
  const hash = sha224(derKey) // 28 bytes
  // Append self-authenticating tag (0x02)
  const principal = new Uint8Array(29)
  principal.set(hash)
  principal[28] = 0x02
  return principal
}

/**
 * CRC-32 lookup table (IEEE polynomial 0xEDB88320).
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1)
      } else {
        c = c >>> 1
      }
    }
    table[i] = c
  }
  return table
})()

/**
 * Compute CRC-32 checksum (IEEE).
 */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Derive the ICP Account Identifier from a principal.
 *
 * Account Identifier = SHA-224( \x0Aaccount-id + principal_bytes + subaccount )
 *
 * The result is a 32-byte value: 4 bytes CRC32 checksum + 28 bytes hash.
 * Returned as a hex string (64 hex chars).
 *
 * @param principal - The principal bytes (typically 29 bytes for self-authenticating)
 * @param subaccount - Optional 32-byte subaccount (defaults to all zeros)
 * @returns 32-byte account identifier as a hex string
 */
export function deriveAccountId(principal: Uint8Array, subaccount?: Uint8Array): string {
  const sub = subaccount ?? new Uint8Array(32)
  if (sub.length !== 32) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Subaccount must be 32 bytes, got ${sub.length}`,
    )
  }

  // Domain separator: \x0Aaccount-id
  const domainSep = new TextEncoder().encode('\x0Aaccount-id')

  // Concatenate: domain_separator + principal + subaccount
  const payload = new Uint8Array(domainSep.length + principal.length + sub.length)
  payload.set(domainSep)
  payload.set(principal, domainSep.length)
  payload.set(sub, domainSep.length + principal.length)

  // SHA-224 hash -> 28 bytes
  const hash = sha224(payload)

  // CRC-32 checksum of the hash
  const checksum = crc32(hash)

  // Result: 4-byte checksum (big-endian) + 28-byte hash = 32 bytes
  const accountId = new Uint8Array(32)
  accountId[0] = (checksum >>> 24) & 0xff
  accountId[1] = (checksum >>> 16) & 0xff
  accountId[2] = (checksum >>> 8) & 0xff
  accountId[3] = checksum & 0xff
  accountId.set(hash, 4)

  return bytesToHex(accountId)
}

/**
 * Encode principal bytes as a textual representation.
 *
 * The textual format is: CRC-32 checksum + principal bytes, base32-encoded (lowercase),
 * grouped into 5-character groups separated by dashes.
 */
export function principalToText(principal: Uint8Array): string {
  // CRC-32 checksum of the principal bytes
  const checksum = crc32(principal)
  const checksumBytes = new Uint8Array(4)
  checksumBytes[0] = (checksum >>> 24) & 0xff
  checksumBytes[1] = (checksum >>> 16) & 0xff
  checksumBytes[2] = (checksum >>> 8) & 0xff
  checksumBytes[3] = checksum & 0xff

  // Concatenate: checksum + principal
  const combined = new Uint8Array(4 + principal.length)
  combined.set(checksumBytes)
  combined.set(principal, 4)

  // Base32 encode (lowercase, no padding)
  const base32Chars = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let value = 0
  let encoded = ''

  for (let i = 0; i < combined.length; i++) {
    value = (value << 8) | combined[i]
    bits += 8
    while (bits >= 5) {
      bits -= 5
      encoded += base32Chars[(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0) {
    encoded += base32Chars[(value << (5 - bits)) & 0x1f]
  }

  // Group into 5-character chunks separated by dashes
  const groups: string[] = []
  for (let i = 0; i < encoded.length; i += 5) {
    groups.push(encoded.slice(i, i + 5))
  }

  return groups.join('-')
}

/**
 * ICP signer implementing the ChainSigner interface.
 * Uses ED25519 keys with SLIP-0010 derivation.
 *
 * Address format: Account Identifier (64 hex chars) derived from the principal.
 * The principal is derived from the DER-encoded ED25519 public key via SHA-224.
 */
export class IcpSigner implements ChainSigner {
  constructor(_network?: 'mainnet' | 'testnet') {}

  getDefaultHdPath(): string {
    return "m/44'/223'/0'/0/0"
  }

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
   * Default path for ICP: m/44'/223'/0'/0'/0'
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKey = slip0010DerivePath(seed, path)
    return addHexPrefix(bytesToHex(privateKey))
  }

  /**
   * Get the ICP account identifier for a given private key.
   * Returns a 64-character hex string (32 bytes: 4 byte CRC32 + 28 byte SHA-224).
   */
  getAddress(privateKey: HexString): Address {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    const publicKey = ed25519.getPublicKey(pkBytes)
    const principal = derivePrincipal(publicKey)
    return deriveAccountId(principal)
  }

  /**
   * Get the Principal ID (textual representation) for a given private key.
   */
  getPrincipalId(privateKey: HexString): string {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    const publicKey = ed25519.getPublicKey(pkBytes)
    const principal = derivePrincipal(publicKey)
    return principalToText(principal)
  }

  /**
   * Sign an ICP transaction.
   * The transaction data is expected to be serialized in tx.data as a hex string.
   * Returns the ED25519 signature as a hex string.
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    try {

      if (pkBytes.length !== 32) {
        throw new ChainKitError(
          ErrorCode.INVALID_PRIVATE_KEY,
          `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
        )
      }

      if (!tx.data) {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'Transaction data (serialized message) is required for ICP signing',
        )
      }

      const messageBytes = hexToBytes(stripHexPrefix(tx.data as string))
      const signature = ed25519.sign(messageBytes, pkBytes)

      return addHexPrefix(bytesToHex(signature))
    } finally {
      pkBytes.fill(0)
    }
  }

  /**
   * Validate an ICP account identifier.
   * ICP account identifiers are 64-character hex strings (32 bytes).
   */
  validateAddress(address: string): boolean {
    try {
      if (address.length !== 64) return false
      return /^[0-9a-fA-F]{64}$/.test(address)
    } catch {
      return false
    }
  }

  /**
   * Sign an arbitrary message with ED25519.
   * Returns the 64-byte signature as a hex string.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    try {

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
    } finally {
      pkBytes.fill(0)
    }
  }
}
