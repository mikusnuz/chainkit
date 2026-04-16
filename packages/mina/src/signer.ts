import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import { pallas } from '@noble/curves/pasta'
import { sha256 } from '@noble/hashes/sha256'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/abstract/utils'
import { base58 } from '@scure/base'
import type { MinaSignature } from './types.js'

/**
 * Mina address version prefix (3 bytes).
 * 0xCB = Mina network marker
 * 0x01 = non-testnet flag
 * 0x01 = compressed pubkey flag
 */
const MINA_ADDRESS_VERSION = new Uint8Array([0xcb, 0x01, 0x01])

/**
 * Mina HD derivation path (BIP44 coin type 12586).
 */
const MINA_HD_PATH = "m/44'/12586'/0'/0/0"

/**
 * The Pallas curve order.
 */
const PALLAS_ORDER = pallas.CURVE.n

/**
 * Reverse the bytes of a Uint8Array (returns a new array).
 */
function reverseBytes(bytes: Uint8Array): Uint8Array {
  const reversed = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    reversed[i] = bytes[bytes.length - 1 - i]
  }
  return reversed
}

/**
 * Convert a BigInt to a 32-byte little-endian Uint8Array.
 */
function bigintToLE32(n: bigint): Uint8Array {
  const be = new Uint8Array(numberToBytesBE(n, 32))
  return reverseBytes(be)
}

/**
 * Convert a 32-byte little-endian Uint8Array to a BigInt.
 */
function le32ToBigint(bytes: Uint8Array): bigint {
  return bytesToNumberBE(reverseBytes(bytes))
}

/**
 * Compute Mina base58check encoding.
 * Format: base58(version(3) + x_coord_LE(32) + is_odd(1) + checksum(4))
 * Checksum = first 4 bytes of SHA-256(SHA-256(version + x_coord + is_odd))
 *
 * Total payload before base58: 3 + 32 + 1 + 4 = 40 bytes
 */
function minaBase58CheckEncode(version: Uint8Array, xCoordLE: Uint8Array, isOdd: boolean): string {
  const data = new Uint8Array(version.length + xCoordLE.length + 1)
  data.set(version, 0)
  data.set(xCoordLE, version.length)
  data[version.length + xCoordLE.length] = isOdd ? 0x01 : 0x00

  const hash1 = sha256(data)
  const hash2 = sha256(hash1)
  const checksum = hash2.slice(0, 4)

  const full = new Uint8Array(data.length + 4)
  full.set(data, 0)
  full.set(checksum, data.length)

  return base58.encode(full)
}

/**
 * Decode Mina base58check format.
 * Returns { version, xCoordLE, isOdd } or throws on invalid checksum.
 *
 * Expected total decoded length: 40 bytes (3 version + 32 x-coord + 1 parity + 4 checksum)
 */
function minaBase58CheckDecode(encoded: string): {
  version: Uint8Array
  xCoordLE: Uint8Array
  isOdd: boolean
} {
  const decoded = base58.decode(encoded)
  // Total must be at least 3 + 32 + 1 + 4 = 40 bytes
  if (decoded.length !== 40) {
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Invalid address length: expected 40 bytes, got ${decoded.length}`)
  }

  const data = decoded.slice(0, 36) // 3 version + 32 x-coord + 1 parity
  const checksum = decoded.slice(36, 40)

  const hash1 = sha256(data)
  const hash2 = sha256(hash1)
  const expectedChecksum = hash2.slice(0, 4)

  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) {
      throw new ChainKitError(ErrorCode.INVALID_ADDRESS, 'Invalid checksum')
    }
  }

  return {
    version: data.slice(0, 3),
    xCoordLE: data.slice(3, 35),
    isOdd: data[35] === 0x01,
  }
}

/**
 * Deterministic nonce generation (RFC 6979-style) for Schnorr signature on Pallas.
 * Uses HMAC-SHA256 to deterministically derive k from private key and message hash.
 */
function deterministicK(privateKey: bigint, msgHash: Uint8Array): bigint {
  const pkBytes = new Uint8Array(numberToBytesBE(privateKey, 32))

  // RFC 6979 simplified: HMAC-SHA256(privateKey || msgHash)
  let v = new Uint8Array(32).fill(0x01)
  let k = new Uint8Array(32).fill(0x00)

  // K = HMAC_K(V || 0x00 || privKey || msgHash)
  k = new Uint8Array(hmac(sha256, k, new Uint8Array([...v, 0x00, ...pkBytes, ...msgHash])))
  // V = HMAC_K(V)
  v = new Uint8Array(hmac(sha256, k, v))
  // K = HMAC_K(V || 0x01 || privKey || msgHash)
  k = new Uint8Array(hmac(sha256, k, new Uint8Array([...v, 0x01, ...pkBytes, ...msgHash])))
  // V = HMAC_K(V)
  v = new Uint8Array(hmac(sha256, k, v))

  // Generate candidate
  while (true) {
    v = new Uint8Array(hmac(sha256, k, v))
    const candidate = bytesToNumberBE(v) % PALLAS_ORDER
    if (candidate > 0n) {
      return candidate
    }
    k = new Uint8Array(hmac(sha256, k, new Uint8Array([...v, 0x00])))
    v = new Uint8Array(hmac(sha256, k, v))
  }
}

/**
 * Hash a message for Mina Schnorr signature (SHA-256 based).
 * This is used for signMessage. Full Mina transaction signing
 * requires Poseidon hash which is a follow-up enhancement.
 */
function hashMessage(message: Uint8Array, pubKeyX: bigint, rx: bigint): Uint8Array {
  // hash(message || pubkey.x || R.x)
  const pubKeyXBytes = new Uint8Array(numberToBytesBE(pubKeyX, 32))
  const rxBytes = new Uint8Array(numberToBytesBE(rx, 32))

  const combined = new Uint8Array(message.length + 64)
  combined.set(message, 0)
  combined.set(pubKeyXBytes, message.length)
  combined.set(rxBytes, message.length + 32)

  return sha256(combined)
}

/**
 * Mina Schnorr sign on Pallas curve.
 *
 * 1. k = deterministic nonce
 * 2. R = k * G
 * 3. e = SHA-256(message || pubkey.x || R.x)
 * 4. s = k - e * privateKey (mod order)
 * 5. Signature = { field: R.x, scalar: s }
 *
 * Note: This implements a simplified Schnorr scheme. Full Mina network
 * transaction signing requires Poseidon hash, which is a follow-up.
 */
function schnorrSign(
  privateKey: bigint,
  messageBytes: Uint8Array,
): MinaSignature {
  const pubPoint = pallas.ProjectivePoint.BASE.multiply(privateKey)
  const pubKeyX = pubPoint.x

  const k = deterministicK(privateKey, messageBytes)
  const R = pallas.ProjectivePoint.BASE.multiply(k)
  const rx = R.x

  const e = bytesToNumberBE(hashMessage(messageBytes, pubKeyX, rx)) % PALLAS_ORDER
  let s = (k - e * privateKey) % PALLAS_ORDER
  if (s < 0n) s += PALLAS_ORDER

  return {
    field: rx.toString(),
    scalar: s.toString(),
  }
}

/**
 * Serialize transaction fields into bytes for hashing.
 */
function serializeTransaction(tx: {
  from: string
  to: string
  amount: string
  fee: string
  nonce: number
  memo?: string
  validUntil?: number
}): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []

  // Serialize each field with a separator
  parts.push(encoder.encode(tx.from))
  parts.push(encoder.encode(tx.to))
  parts.push(encoder.encode(tx.amount))
  parts.push(encoder.encode(tx.fee))
  parts.push(new Uint8Array(numberToBytesBE(BigInt(tx.nonce), 4)))
  if (tx.memo) {
    parts.push(encoder.encode(tx.memo))
  }
  if (tx.validUntil !== undefined) {
    parts.push(new Uint8Array(numberToBytesBE(BigInt(tx.validUntil), 4)))
  }

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }

  return sha256(result)
}

/**
 * Mina signer implementing the ChainSigner interface.
 *
 * Uses the Pallas curve from the Pasta curves family.
 * Addresses are base58check encoded with the B62 prefix.
 * Signatures use a custom Schnorr scheme on Pallas.
 *
 * Note: Transaction signing uses SHA-256 hashing of serialized fields.
 * Full Mina network-compatible transaction signing requires Poseidon
 * hash, which is planned as a follow-up enhancement.
 */
export class MinaSigner implements ChainSigner {
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
   * Derive a private key from a mnemonic using BIP44 path m/44'/12586'/0'/0/0.
   * The raw BIP32 key is taken modulo the Pallas curve order.
   * Returns a hex string (no 0x prefix).
   */
  async derivePrivateKey(mnemonic: string, path: string = MINA_HD_PATH): Promise<string> {
    const seed = await mnemonicToSeed(mnemonic)
    const rawKeyHex = derivePath(seed, path)
    const rawKey = bytesToNumberBE(hexToBytes(rawKeyHex))

    // Take modulo Pallas curve order
    const privateKey = rawKey % PALLAS_ORDER
    if (privateKey === 0n) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        'Derived private key is zero after modulo reduction',
      )
    }

    return bytesToHex(new Uint8Array(numberToBytesBE(privateKey, 32)))
  }

  /**
   * Get the Mina address (B62...) from a private key.
   *
   * 1. Multiply private key by generator point on Pallas curve
   * 2. Get x-coordinate of the public key point
   * 3. Check parity of y-coordinate, and if y is odd, negate the point
   *    (Mina uses even-y convention for addresses)
   * 4. Encode: base58check(0xCB || x_coord_le_bytes || checksum)
   */
  getAddress(privateKey: string): string {
    const pkHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
    const pkBytes = hexToBytes(pkHex)

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    const pk = bytesToNumberBE(pkBytes)
    if (pk === 0n || pk >= PALLAS_ORDER) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        'Private key out of valid range for Pallas curve',
      )
    }

    const pubPoint = pallas.ProjectivePoint.BASE.multiply(pk)
    const x = pubPoint.x
    const y = pubPoint.y

    // Check parity of y-coordinate
    const isOdd = y % 2n === 1n

    // Encode x-coordinate as 32 bytes little-endian
    const xBytes = bigintToLE32(x)

    return minaBase58CheckEncode(MINA_ADDRESS_VERSION, xBytes, isOdd)
  }

  /**
   * Validate a Mina address.
   * Checks for B62 prefix, proper base58check encoding, and correct version byte.
   */
  validateAddress(address: string): boolean {
    if (!address.startsWith('B62')) return false

    try {
      const { version, xCoordLE } = minaBase58CheckDecode(address)
      // Verify version prefix matches
      if (version[0] !== MINA_ADDRESS_VERSION[0]) return false
      if (version[1] !== MINA_ADDRESS_VERSION[1]) return false
      if (version[2] !== MINA_ADDRESS_VERSION[2]) return false
      if (xCoordLE.length !== 32) return false
      return true
    } catch {
      return false
    }
  }

  /**
   * Sign a Mina transaction using Schnorr signature on Pallas curve.
   *
   * Returns a JSON string containing { field, scalar } signature fields
   * alongside the serialized transaction.
   *
   * Note: Uses SHA-256 for hashing. Full Mina network compatibility
   * requires Poseidon hash (follow-up enhancement).
   */
  async signTransaction(params: SignTransactionParams): Promise<string> {
    const { privateKey, tx } = params
    const pkHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
    const pk = bytesToNumberBE(hexToBytes(pkHex))

    if (pk === 0n || pk >= PALLAS_ORDER) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        'Private key out of valid range',
      )
    }

    const from = tx.from ?? this.getAddress(privateKey)
    const to = tx.to
    const amount = tx.value ?? tx.amount ?? '0'
    const fee = tx.fee?.fee ?? '10000000' // default 0.01 MINA
    const nonce = tx.nonce ?? 0
    const memo = tx.memo ?? ''
    const validUntil = (tx.extra?.validUntil as number) ?? 4294967295

    const txHash = serializeTransaction({
      from,
      to,
      amount,
      fee,
      nonce,
      memo,
      validUntil,
    })

    const signature = schnorrSign(pk, txHash)

    return JSON.stringify({
      signature,
      payment: {
        from,
        to,
        amount,
        fee,
        nonce,
        memo,
        validUntil,
      },
    })
  }

  /**
   * Sign an arbitrary message using Schnorr signature on Pallas curve.
   *
   * Returns a JSON string containing { field, scalar } signature.
   */
  async signMessage(params: SignMessageParams): Promise<string> {
    const { privateKey, message } = params
    const pkHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
    const pk = bytesToNumberBE(hexToBytes(pkHex))

    if (pk === 0n || pk >= PALLAS_ORDER) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        'Private key out of valid range',
      )
    }

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Hash the message with SHA-256 first to get a fixed-size input
    const msgHash = sha256(msgBytes)
    const signature = schnorrSign(pk, msgHash)

    return JSON.stringify(signature)
  }
}
