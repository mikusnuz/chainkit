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
 * Tezos block hash prefix bytes: \x01\x34
 * Used for base58check encoding of block hashes (B...).
 */
const BLOCK_HASH_PREFIX = new Uint8Array([0x01, 0x34])

/**
 * Tezos operation tag for reveal operations.
 */
const REVEAL_TAG = 0x6b

/**
 * Tezos operation tag for transaction operations.
 */
const TRANSACTION_TAG = 0x6c

/**
 * Watermark byte for generic operations (used before hashing for signing).
 */
const GENERIC_WATERMARK = 0x03

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

// ===== Zarith encoding =====

/**
 * Encode an unsigned integer using Tezos zarith (variable-length) encoding.
 * Each byte uses 7 bits for data and 1 bit (MSB) as continuation flag.
 * Accepts number, bigint, or string (parsed as decimal).
 */
function zarithEncode(value: string | number | bigint): Uint8Array {
  const bytes: number[] = []
  let v = typeof value === 'bigint' ? value : BigInt(value)
  if (v < 0n) {
    throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'zarithEncode: value must be non-negative')
  }
  // Special case: zero
  if (v === 0n) {
    bytes.push(0)
    return new Uint8Array(bytes)
  }
  while (v >= 0x80n) {
    bytes.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  bytes.push(Number(v))
  return new Uint8Array(bytes)
}

// ===== Base58check decode helpers =====

/**
 * Decode a base58check-encoded string and remove a known prefix.
 * Returns the raw bytes after the prefix.
 */
function b58cDecodeWithPrefix(encoded: string, prefix: Uint8Array): Uint8Array {
  const decoded = b58c.decode(encoded)
  // Verify prefix matches
  for (let i = 0; i < prefix.length; i++) {
    if (decoded[i] !== prefix[i]) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        `base58check prefix mismatch: expected ${bytesToHex(prefix)}, got ${bytesToHex(decoded.slice(0, prefix.length))}`,
      )
    }
  }
  return decoded.slice(prefix.length)
}

/**
 * Decode a Tezos block hash (B...) to its raw 32 bytes.
 */
function decodeBlockHash(blockHash: string): Uint8Array {
  const raw = b58cDecodeWithPrefix(blockHash, BLOCK_HASH_PREFIX)
  if (raw.length !== 32) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid block hash: expected 32 bytes after prefix, got ${raw.length}`,
    )
  }
  return raw
}

/**
 * Decode a tz1 address to its 20-byte public key hash.
 * Returns a 21-byte array: 1 byte tag (0x00 for tz1) + 20 bytes hash.
 */
function decodeTz1Address(address: string): Uint8Array {
  if (!address.startsWith('tz1')) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Only tz1 addresses are supported, got: ${address}`,
    )
  }
  const pkHash = b58cDecodeWithPrefix(address, TZ1_PREFIX)
  if (pkHash.length !== 20) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid tz1 address: expected 20-byte hash, got ${pkHash.length}`,
    )
  }
  // Tag 0x00 = ED25519 (tz1)
  const result = new Uint8Array(21)
  result[0] = 0x00
  result.set(pkHash, 1)
  return result
}

/**
 * Encode a Tezos implicit address (tz1/tz2/tz3) as a 22-byte destination.
 * Format: 0x00 (implicit) + address tag + 20-byte hash + 0x00 (padding).
 *
 * For KT1 contract addresses: 0x01 + 20-byte hash + 0x00 (padding).
 */
function encodeDestination(address: string): Uint8Array {
  const result = new Uint8Array(22)

  if (address.startsWith('KT1')) {
    // Contract address prefix: \x02\x5a\x79
    const KT1_PREFIX = new Uint8Array([0x02, 0x5a, 0x79])
    const hash = b58cDecodeWithPrefix(address, KT1_PREFIX)
    if (hash.length !== 20) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        `Invalid KT1 address: expected 20-byte hash, got ${hash.length}`,
      )
    }
    result[0] = 0x01 // contract tag
    result.set(hash, 1)
    result[21] = 0x00 // padding
  } else if (address.startsWith('tz1')) {
    const decoded = decodeTz1Address(address) // 21 bytes: tag + hash
    result[0] = 0x00 // implicit tag
    result.set(decoded, 1) // tag (0x00) + 20-byte hash
  } else if (address.startsWith('tz2')) {
    // tz2 prefix: \x06\xa1\xa1
    const TZ2_PREFIX = new Uint8Array([0x06, 0xa1, 0xa1])
    const hash = b58cDecodeWithPrefix(address, TZ2_PREFIX)
    result[0] = 0x00 // implicit
    result[1] = 0x01 // secp256k1 tag
    result.set(hash, 2)
  } else if (address.startsWith('tz3')) {
    // tz3 prefix: \x06\xa1\xa4
    const TZ3_PREFIX = new Uint8Array([0x06, 0xa1, 0xa4])
    const hash = b58cDecodeWithPrefix(address, TZ3_PREFIX)
    result[0] = 0x00 // implicit
    result[1] = 0x02 // p256 tag
    result.set(hash, 2)
  } else {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Unsupported destination address format: ${address}`,
    )
  }

  return result
}

// ===== Operation forging =====

/**
 * Parameters for forging a Tezos transaction operation.
 */
export interface TezosForgeParams {
  /** Block hash to use as branch (B...) */
  branch: string
  /** Source tz1 address */
  source: string
  /** Destination address (tz1/tz2/tz3/KT1) */
  destination: string
  /** Amount in mutez */
  amount: string | number | bigint
  /** Fee in mutez */
  fee: string | number | bigint
  /** Account counter (nonce) */
  counter: string | number | bigint
  /** Gas limit */
  gasLimit: string | number | bigint
  /** Storage limit */
  storageLimit: string | number | bigint
  /** Whether to include parameters (default: false / no params) */
  parameters?: boolean
}

/**
 * Forge a Tezos transaction operation into binary bytes.
 *
 * Binary format:
 *   branch (32 bytes)
 *   + operation tag (1 byte, 0x6c for transaction)
 *   + source (21 bytes: tag + 20-byte hash)
 *   + fee (zarith)
 *   + counter (zarith)
 *   + gas_limit (zarith)
 *   + storage_limit (zarith)
 *   + amount (zarith)
 *   + destination (22 bytes)
 *   + parameters flag (1 byte: 0x00 = none)
 */
function forgeTransaction(params: TezosForgeParams): Uint8Array {
  const branch = decodeBlockHash(params.branch)
  const source = decodeTz1Address(params.source)
  const fee = zarithEncode(params.fee)
  const counter = zarithEncode(params.counter)
  const gasLimit = zarithEncode(params.gasLimit)
  const storageLimit = zarithEncode(params.storageLimit)
  const amount = zarithEncode(params.amount)
  const destination = encodeDestination(params.destination)

  // No parameters (0x00)
  const paramsFlag = new Uint8Array([0x00])

  // Calculate total size
  const totalSize =
    branch.length +       // 32
    1 +                   // operation tag
    source.length +       // 21
    fee.length +          // variable
    counter.length +      // variable
    gasLimit.length +     // variable
    storageLimit.length + // variable
    amount.length +       // variable
    destination.length +  // 22
    paramsFlag.length     // 1

  const forged = new Uint8Array(totalSize)
  let offset = 0

  forged.set(branch, offset); offset += branch.length
  forged[offset] = TRANSACTION_TAG; offset += 1
  forged.set(source, offset); offset += source.length
  forged.set(fee, offset); offset += fee.length
  forged.set(counter, offset); offset += counter.length
  forged.set(gasLimit, offset); offset += gasLimit.length
  forged.set(storageLimit, offset); offset += storageLimit.length
  forged.set(amount, offset); offset += amount.length
  forged.set(destination, offset); offset += destination.length
  forged.set(paramsFlag, offset)

  return forged
}

// ===== Reveal operation forging =====

/**
 * Parameters for forging a Tezos reveal operation.
 */
export interface TezosRevealParams {
  /** Block hash to use as branch (B...) */
  branch: string
  /** Source tz1 address */
  source: string
  /** Fee in mutez */
  fee: string | number | bigint
  /** Account counter (nonce) */
  counter: string | number | bigint
  /** Gas limit */
  gasLimit: string | number | bigint
  /** Storage limit */
  storageLimit: string | number | bigint
  /** Raw ED25519 public key (32 bytes) */
  publicKey: Uint8Array
}

/**
 * Forge a Tezos reveal operation into binary bytes.
 *
 * Binary format:
 *   branch (32 bytes)
 *   + operation tag (1 byte, 0x6b for reveal)
 *   + source (21 bytes: tag + 20-byte hash)
 *   + fee (zarith)
 *   + counter (zarith)
 *   + gas_limit (zarith)
 *   + storage_limit (zarith)
 *   + public_key (1 byte tag (0x00=ed25519) + 32 bytes)
 */
function forgeReveal(params: TezosRevealParams): Uint8Array {
  const branch = decodeBlockHash(params.branch)
  const source = decodeTz1Address(params.source)
  const fee = zarithEncode(params.fee)
  const counter = zarithEncode(params.counter)
  const gasLimit = zarithEncode(params.gasLimit)
  const storageLimit = zarithEncode(params.storageLimit)

  // Public key: 0x00 tag (ed25519) + 32-byte key
  const pubKeyEncoded = new Uint8Array(33)
  pubKeyEncoded[0] = 0x00
  pubKeyEncoded.set(params.publicKey, 1)

  // Trailing padding byte (required by recent Tezos protocols)
  const trailingPad = new Uint8Array([0x00])

  const totalSize =
    branch.length +       // 32
    1 +                   // operation tag
    source.length +       // 21
    fee.length +          // variable
    counter.length +      // variable
    gasLimit.length +     // variable
    storageLimit.length + // variable
    pubKeyEncoded.length + // 33
    trailingPad.length    // 1

  const forged = new Uint8Array(totalSize)
  let offset = 0

  forged.set(branch, offset); offset += branch.length
  forged[offset] = REVEAL_TAG; offset += 1
  forged.set(source, offset); offset += source.length
  forged.set(fee, offset); offset += fee.length
  forged.set(counter, offset); offset += counter.length
  forged.set(gasLimit, offset); offset += gasLimit.length
  forged.set(storageLimit, offset); offset += storageLimit.length
  forged.set(pubKeyEncoded, offset); offset += pubKeyEncoded.length
  forged.set(trailingPad, offset)

  return forged
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
  constructor(_network?: 'mainnet' | 'testnet') {}

  getDefaultHdPath(): string {
    return "m/44'/1729'/0'/0'"
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
   *
   * Supports two modes:
   *
   * 1. **Structured forging** (recommended): Pass Tezos operation fields via `tx.extra`:
   *    - `tx.extra.branch` (string): Block hash (B...)
   *    - `tx.extra.counter` (string): Account counter/nonce
   *    - `tx.extra.gasLimit` (string): Gas limit (default: "10300")
   *    - `tx.extra.storageLimit` (string): Storage limit (default: "0")
   *    - `tx.from`: Source tz1 address
   *    - `tx.to`: Destination address (tz1/tz2/tz3/KT1)
   *    - `tx.value`: Amount in mutez
   *    - `tx.fee`: `{ amount: string }` or the fee field from `tx.extra.fee`
   *
   * 2. **Pre-forged bytes** (legacy): Pass hex-encoded forged operation in `tx.data`.
   *
   * Returns hex-encoded: forged_operation_bytes + ED25519_signature (64 bytes).
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

      let operationBytes: Uint8Array

      if (tx.extra?.branch) {
        // Structured forging mode: forge the operation from tx fields
        const branch = tx.extra.branch as string
        const counter = tx.extra.counter as string
        const gasLimit = (tx.extra.gasLimit as string) ?? '10300'
        const storageLimit = (tx.extra.storageLimit as string) ?? '0'
        const fee = (tx.fee?.fee as string) ?? (tx.fee?.amount as string) ?? (tx.extra?.fee as string) ?? '0'

        if (!tx.from || !tx.to || !counter) {
          throw new ChainKitError(
            ErrorCode.INVALID_PARAMS,
            'Structured forging requires: from, to, value, extra.branch, extra.counter',
          )
        }

        operationBytes = forgeTransaction({
          branch,
          source: tx.from as string,
          destination: tx.to,
          amount: (tx.value ?? tx.amount ?? '0') as string,
          fee,
          counter,
          gasLimit,
          storageLimit,
        })
      } else if (tx.data) {
        // Legacy mode: use pre-forged bytes
        operationBytes = hexToBytes(stripHexPrefix(tx.data as string))
      } else {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'Transaction requires either extra.branch (for forging) or data (pre-forged operation bytes)',
        )
      }

      // Tezos signs blake2b-256 of (0x03 || operation_bytes)
      // 0x03 is the watermark for generic operations
      const watermarked = new Uint8Array(1 + operationBytes.length)
      watermarked[0] = GENERIC_WATERMARK
      watermarked.set(operationBytes, 1)
      const hash = blake2b(watermarked, { dkLen: 32 })

      // Sign with ED25519
      const signature = ed25519.sign(hash, pkBytes)

      // Return forged bytes + 64-byte signature
      const result = new Uint8Array(operationBytes.length + signature.length)
      result.set(operationBytes)
      result.set(signature, operationBytes.length)

      return addHexPrefix(bytesToHex(result))
    } finally {
      pkBytes.fill(0)
    }
  }

  /**
   * Validate a Tezos address.
   * Accepts tz1, tz2, tz3 (implicit) and KT1 (contract) addresses.
   * Validates base58check encoding and prefix.
   */
  validateAddress(address: string): boolean {
    try {
      if (address.startsWith('tz1')) {
        b58cDecodeWithPrefix(address, TZ1_PREFIX)
        return true
      }
      if (address.startsWith('tz2')) {
        const TZ2_PREFIX = new Uint8Array([0x06, 0xa1, 0xa1])
        b58cDecodeWithPrefix(address, TZ2_PREFIX)
        return true
      }
      if (address.startsWith('tz3')) {
        const TZ3_PREFIX = new Uint8Array([0x06, 0xa1, 0xa4])
        b58cDecodeWithPrefix(address, TZ3_PREFIX)
        return true
      }
      if (address.startsWith('KT1')) {
        const KT1_PREFIX = new Uint8Array([0x02, 0x5a, 0x79])
        b58cDecodeWithPrefix(address, KT1_PREFIX)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * Sign an arbitrary message with ED25519.
   * The message is hashed with blake2b-256 before signing (Tezos convention).
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

      // Tezos message signing: blake2b-256 hash then sign
      const hash = blake2b(msgBytes, { dkLen: 32 })
      const signature = ed25519.sign(hash, pkBytes)

      return addHexPrefix(bytesToHex(signature))
    } finally {
      pkBytes.fill(0)
    }
  }
}

// Re-export utility functions for use by provider or external consumers
export {
  publicKeyToTz1Address,
  encodePublicKey,
  encodeSignature,
  forgeTransaction,
  forgeReveal,
  zarithEncode,
  decodeBlockHash,
  decodeTz1Address,
  encodeDestination,
}
