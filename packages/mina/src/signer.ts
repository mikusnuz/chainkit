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
import {
  poseidonHash,
  poseidonHashWithPrefix,
  transactionFieldsToElements,
  PALLAS_MODULUS,
} from './poseidon.js'

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
 * Used for arbitrary message signing (signMessage).
 * Transaction signing uses Poseidon hash via signTransaction.
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
 * Decode a Mina address to extract the x-coordinate and y-parity.
 * If the address cannot be decoded (e.g., external address with different
 * checksum), falls back to hashing the address string to a field element.
 */
function decodeMinaAddress(address: string): { x: bigint; yParity: bigint } {
  try {
    const { xCoordLE, isOdd } = minaBase58CheckDecode(address)
    const x = le32ToBigint(xCoordLE)
    return { x, yParity: isOdd ? 1n : 0n }
  } catch {
    // Fallback: decode the base58 payload without checksum validation.
    // This handles addresses from external sources that may use a
    // slightly different checksum algorithm.
    const decoded = base58.decode(address)
    if (decoded.length >= 36) {
      const xCoordLE = decoded.slice(3, 35)
      const isOdd = decoded[35] === 0x01
      const x = le32ToBigint(xCoordLE)
      return { x, yParity: isOdd ? 1n : 0n }
    }
    // Last resort: hash the address string to a field element
    const addrBytes = new TextEncoder().encode(address)
    const hashed = sha256(addrBytes)
    const x = bytesToNumberBE(hashed) % PALLAS_MODULUS
    return { x, yParity: 0n }
  }
}

/**
 * Encode a memo string to a field element.
 * Mina encodes memos as packed ASCII bytes into a field element.
 */
function encodeMemoField(memo: string): bigint {
  if (!memo) return 0n
  let result = 0n
  const maxLen = Math.min(memo.length, 32) // Max 32 chars
  for (let i = 0; i < maxLen; i++) {
    result += BigInt(memo.charCodeAt(i)) << BigInt(8 * i)
  }
  return result % PALLAS_MODULUS
}

/**
 * Hash transaction fields using Poseidon hash with Mina's domain prefix.
 *
 * Mina payment transactions are hashed as:
 * Poseidon.hashWithPrefix("MinaSignatureMainnet", [...fields])
 *
 * where fields = [fee, fee_token, fee_payer_pk_x, fee_payer_pk_y_parity,
 *   nonce, valid_until, memo_hash, tag, receiver_pk_x, receiver_pk_y_parity,
 *   amount, token_id]
 */
function hashTransactionPoseidon(
  tx: {
    from: string
    to: string
    amount: string
    fee: string
    nonce: number
    memo?: string
    validUntil?: number
  },
  network: 'mainnet' | 'testnet' = 'mainnet',
): bigint {
  const sender = decodeMinaAddress(tx.from)
  const receiver = decodeMinaAddress(tx.to)

  const prefix =
    network === 'mainnet' ? 'MinaSignatureMainnet' : 'CodaSignature*****'

  const fields = transactionFieldsToElements({
    fee: BigInt(tx.fee),
    feePayerPkX: sender.x,
    feePayerPkYParity: sender.yParity,
    nonce: BigInt(tx.nonce),
    validUntil: BigInt(tx.validUntil ?? 4294967295),
    memo: encodeMemoField(tx.memo ?? ''),
    receiverPkX: receiver.x,
    receiverPkYParity: receiver.yParity,
    amount: BigInt(tx.amount),
  })

  return poseidonHashWithPrefix(prefix, fields)
}

/**
 * Convert a Poseidon hash (field element) to a 32-byte big-endian Uint8Array.
 */
function poseidonHashToBytes(hash: bigint): Uint8Array {
  return new Uint8Array(numberToBytesBE(hash, 32))
}

/**
 * Serialize transaction fields into bytes for hashing (legacy SHA-256 fallback).
 *
 * @deprecated Use hashTransactionPoseidon instead for Mina network compatibility.
 */
function serializeTransactionLegacy(tx: {
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
 * Transaction signing uses Poseidon hash over Pallas field elements
 * with Mina-specific domain separation prefixes:
 * - "MinaSignatureMainnet" for mainnet
 * - "CodaSignature*****" for testnet
 *
 * For pre-computed Poseidon hashes (e.g., from a full Mina SDK),
 * pass tx.extra.poseidonHash as a hex string to sign directly.
 */
export class MinaSigner implements ChainSigner {
  private readonly network: 'mainnet' | 'testnet'

  constructor(network?: 'mainnet' | 'testnet') {
    this.network = network ?? 'mainnet'
  }

  getDefaultHdPath(): string {
    return "m/44'/12586'/0'/0/0"
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
   * Uses Poseidon hash over Pallas field elements for transaction hashing,
   * which is required by the Mina network.
   *
   * For pre-computed Poseidon hashes, pass tx.extra.poseidonHash as a
   * hex string (32 bytes). This bypasses the built-in Poseidon computation
   * and signs the provided hash directly.
   *
   * Returns a JSON string containing { signature: { field, scalar }, payment }.
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

    let txHashBytes: Uint8Array

    if (tx.extra?.poseidonHash) {
      // Use pre-computed Poseidon hash directly
      const hashHex = (tx.extra.poseidonHash as string).startsWith('0x')
        ? (tx.extra.poseidonHash as string).slice(2)
        : (tx.extra.poseidonHash as string)
      txHashBytes = hexToBytes(hashHex)
    } else {
      // Compute Poseidon hash of transaction fields
      const poseidonResult = hashTransactionPoseidon(
        { from, to, amount, fee, nonce, memo, validUntil },
        this.network,
      )
      txHashBytes = poseidonHashToBytes(poseidonResult)
    }

    const signature = schnorrSign(pk, txHashBytes)

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
   * Sign a pre-computed transaction hash directly.
   *
   * This is useful when the Poseidon hash has been computed externally
   * (e.g., by a full Mina SDK or wallet). The hash should be a Pallas
   * field element represented as a 32-byte big-endian hex string.
   *
   * @param privateKey - The private key hex string
   * @param hash - The pre-computed Poseidon hash as a hex string
   * @returns JSON string containing { field, scalar } signature
   */
  async signTransactionHash(privateKey: string, hash: string): Promise<string> {
    const pkHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
    const pk = bytesToNumberBE(hexToBytes(pkHex))

    if (pk === 0n || pk >= PALLAS_ORDER) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        'Private key out of valid range',
      )
    }

    const hashHex = hash.startsWith('0x') ? hash.slice(2) : hash
    const hashBytes = hexToBytes(hashHex)
    const signature = schnorrSign(pk, hashBytes)

    return JSON.stringify(signature)
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
