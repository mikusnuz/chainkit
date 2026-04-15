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
import { blake2b } from '@noble/hashes/blake2b'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { base58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha256'

// @noble/ed25519 v2 requires setting the sha512 hash function
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

// base58check uses sha256 double hash for checksum
const b58c = base58check(sha256)

/**
 * Tezos tz1 address prefix bytes: \x06\xa1\x9f
 * Used for base58check encoding of ED25519 public key hashes.
 */
const TZ1_PREFIX = new Uint8Array([0x06, 0xa1, 0x9f])

/**
 * Tezos edpk public key prefix bytes: \x0d\x0f\x25\xd9
 * Used for base58check encoding of ED25519 public keys.
 */
const EDPK_PREFIX = new Uint8Array([0x0d, 0x0f, 0x25, 0xd9])

/**
 * Tezos edsig signature prefix bytes: \x09\xf5\xcd\x86\x12
 * Used for base58check encoding of ED25519 signatures.
 */
const EDSIG_PREFIX = new Uint8Array([0x09, 0xf5, 0xcd, 0x86, 0x12])

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
      `Invalid derivation path: "${path}". Expected format: m/44'/1729'/0'/0'`,
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
 * Compute a tz1 address from a raw ED25519 public key (32 bytes).
 * 1. Blake2b-160 hash of the public key
 * 2. Prepend TZ1_PREFIX (\x06\xa1\x9f)
 * 3. Base58check encode
 */
function publicKeyToTz1Address(publicKey: Uint8Array): string {
  const pkHash = blake2b(publicKey, { dkLen: 20 })
  const payload = new Uint8Array(TZ1_PREFIX.length + pkHash.length)
  payload.set(TZ1_PREFIX)
  payload.set(pkHash, TZ1_PREFIX.length)
  return b58c.encode(payload)
}

/**
 * Encode an ED25519 public key in Tezos format (edpk...).
 */
function encodePublicKey(publicKey: Uint8Array): string {
  const payload = new Uint8Array(EDPK_PREFIX.length + publicKey.length)
  payload.set(EDPK_PREFIX)
  payload.set(publicKey, EDPK_PREFIX.length)
  return b58c.encode(payload)
}

/**
 * Encode an ED25519 signature in Tezos format (edsig...).
 */
function encodeSignature(signature: Uint8Array): string {
  const payload = new Uint8Array(EDSIG_PREFIX.length + signature.length)
  payload.set(EDSIG_PREFIX)
  payload.set(signature, EDSIG_PREFIX.length)
  return b58c.encode(payload)
}

/**
 * Tezos signer implementing the ChainSigner interface.
 * Uses ED25519 keys with SLIP-0010 derivation and tz1 addresses.
 *
 * Default HD path: m/44'/1729'/0'/0'
 */
export class TezosSigner implements ChainSigner {
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
   * Get the Tezos tz1 address for a given private key.
   * The address is blake2b-160 of the ED25519 public key, base58check encoded with tz1 prefix.
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

    return publicKeyToTz1Address(publicKey)
  }

  /**
   * Get the Tezos-encoded public key (edpk...) for a given private key.
   */
  getPublicKey(privateKey: HexString): string {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    const publicKey = ed25519.getPublicKey(pkBytes)
    return encodePublicKey(publicKey)
  }

  /**
   * Sign a Tezos transaction.
   * The transaction data is expected to be a hex-encoded forged operation in tx.data.
   * The operation bytes are prefixed with 0x03 watermark before signing.
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

    if (!tx.data) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Transaction data (forged operation bytes) is required for Tezos signing',
      )
    }

    const operationBytes = hexToBytes(stripHexPrefix(tx.data))

    // Tezos signs blake2b-256 of (0x03 || operation_bytes)
    // 0x03 is the watermark for generic operations
    const watermarked = new Uint8Array(1 + operationBytes.length)
    watermarked[0] = 0x03
    watermarked.set(operationBytes, 1)
    const hash = blake2b(watermarked, { dkLen: 32 })

    // Sign with ED25519
    const signature = ed25519.sign(hash, pkBytes)

    return addHexPrefix(bytesToHex(signature))
  }

  /**
   * Sign an arbitrary message with ED25519.
   * The message is hashed with blake2b-256 before signing (Tezos convention).
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

    // Tezos message signing: blake2b-256 hash then sign
    const hash = blake2b(msgBytes, { dkLen: 32 })
    const signature = ed25519.sign(hash, pkBytes)

    return addHexPrefix(bytesToHex(signature))
  }
}

// Re-export utility functions for use by provider or external consumers
export { publicKeyToTz1Address, encodePublicKey, encodeSignature }
