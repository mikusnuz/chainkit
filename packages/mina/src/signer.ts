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
import { blake2b } from '@noble/hashes/blake2b'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/abstract/utils'
import { base58 } from '@scure/base'
import type { MinaSignature } from './types.js'
import {
  poseidonLegacyHashWithPrefix,
  packToFieldsLegacy,
  inputToBitsLegacy,
  HashInputLegacyOps,
  publicKeyToInputLegacy,
  tagToInputBits,
  uint64ToBits,
  uint32ToBits,
  memoToBits,
  LEGACY_TOKEN_ID,
  PALLAS_MODULUS,
} from './poseidon.js'
import type { HashInputLegacy } from './poseidon.js'
import { PREFIXES, PALLAS_SCALAR_ORDER } from './poseidon-constants.js'

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
 * The Pallas curve order (scalar field Fq).
 */
const PALLAS_ORDER = pallas.CURVE.n

/**
 * Mina's generator point on Pallas curve.
 * This differs from the standard Pallas generator used in noble-curves.
 * Mina uses the point (1, y) where y is the even square root of (1 + 5) in Fp.
 */
const MINA_GENERATOR = pallas.ProjectivePoint.fromAffine({
  x: 1n,
  y: 12418654782883325593414442427049395787963493412651469444558597405572177144507n,
})

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
 */
function minaBase58CheckDecode(encoded: string): {
  version: Uint8Array
  xCoordLE: Uint8Array
  isOdd: boolean
} {
  const decoded = base58.decode(encoded)
  if (decoded.length !== 40) {
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Invalid address length: expected 40 bytes, got ${decoded.length}`)
  }

  const data = decoded.slice(0, 36)
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

// ---- Scalar field arithmetic ----

function scalarMod(a: bigint): bigint {
  const r = a % PALLAS_ORDER
  return r < 0n ? r + PALLAS_ORDER : r
}

function scalarAdd(a: bigint, b: bigint): bigint {
  return scalarMod(a + b)
}

function scalarMul(a: bigint, b: bigint): bigint {
  return scalarMod(a * b)
}

function scalarNegate(a: bigint): bigint {
  return scalarMod(-a)
}

/**
 * Convert a scalar (bigint) to 255 little-endian bits.
 */
function scalarToBits(s: bigint): boolean[] {
  const bits: boolean[] = []
  const val = scalarMod(s)
  for (let i = 0; i < 255; i++) {
    bits.push(((val >> BigInt(i)) & 1n) === 1n)
  }
  return bits
}

/**
 * Check if a field element is even (LSB = 0).
 */
function fieldIsEven(x: bigint): boolean {
  const v = ((x % PALLAS_MODULUS) + PALLAS_MODULUS) % PALLAS_MODULUS
  return (v & 1n) === 0n
}

// ---- Bit/byte conversion helpers ----

function bitsToBytes(bits: boolean[]): number[] {
  const bytes: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8 && i + j < bits.length; j++) {
      if (bits[i + j]) {
        byte |= 1 << j
      }
    }
    bytes.push(byte)
  }
  return bytes
}

function bytesToBits(bytes: number[]): boolean[] {
  const bits: boolean[] = []
  for (const byte of bytes) {
    for (let j = 0; j < 8; j++) {
      bits.push(((byte >> j) & 1) === 1)
    }
  }
  return bits
}

/**
 * Get network ID hash input.
 * mainnet = 0x01, testnet/devnet = 0x00
 */
function getNetworkIdByte(networkId: 'mainnet' | 'testnet'): number {
  return networkId === 'mainnet' ? 0x01 : 0x00
}

/**
 * Get the signature prefix for a given network.
 */
function signaturePrefix(networkId: 'mainnet' | 'testnet'): string {
  return networkId === 'mainnet' ? PREFIXES.signatureMainnet : PREFIXES.signatureTestnet
}

// ---- Mina Schnorr Signature ----

/**
 * Derive a deterministic nonce (k) for legacy signing using blake2b.
 *
 * This matches o1js `deriveNonceLegacy`:
 * 1. Append public key (x, y) as fields to the message input
 * 2. Append private key bits and network ID bits
 * 3. Convert everything to bits, then to bytes
 * 4. Hash with blake2b(32)
 * 5. Mask top 2 bits to fit in scalar field
 * 6. Return as scalar
 */
function deriveNonceLegacy(
  message: HashInputLegacy,
  publicKey: { x: bigint; y: bigint },
  privateKey: bigint,
  networkId: 'mainnet' | 'testnet',
): bigint {
  const pkBits = scalarToBits(privateKey)
  const idBits = bytesToBits([getNetworkIdByte(networkId)])

  const input = HashInputLegacyOps.append(message, {
    fields: [publicKey.x, publicKey.y],
    bits: [...pkBits, ...idBits],
  })

  const inputBits = inputToBitsLegacy(input)
  const inputBytes = bitsToBytes(inputBits)

  const hashBytes = blake2b(Uint8Array.from(inputBytes), { dkLen: 32 })
  const mutableBytes = new Uint8Array(hashBytes)
  // Mask top 2 bits to ensure result fits in scalar field
  mutableBytes[mutableBytes.length - 1] &= 0x3f

  // Convert from little-endian bytes to bigint
  let result = 0n
  for (let i = 0; i < mutableBytes.length; i++) {
    result += BigInt(mutableBytes[i]) << BigInt(8 * i)
  }

  return scalarMod(result)
}

/**
 * Hash a message for legacy Mina Schnorr signature using Poseidon.
 *
 * This matches o1js `hashMessageLegacy`:
 * 1. Append [pk.x, pk.y, r] as fields to the message
 * 2. Pack the combined input to field elements
 * 3. Hash with Poseidon using the network prefix
 *
 * Returns the hash as a scalar (mod scalar field order).
 */
function hashMessageLegacy(
  message: HashInputLegacy,
  publicKey: { x: bigint; y: bigint },
  r: bigint,
  networkId: 'mainnet' | 'testnet',
): bigint {
  const input = HashInputLegacyOps.append(message, {
    fields: [publicKey.x, publicKey.y, r],
    bits: [],
  })

  const prefix = signaturePrefix(networkId)
  const packed = packToFieldsLegacy(input)
  return poseidonLegacyHashWithPrefix(prefix, packed)
}

/**
 * Mina Schnorr sign on Pallas curve (legacy format).
 *
 * This matches o1js `signLegacy`:
 * 1. k' = deriveNonceLegacy(message, pk, sk, networkId)
 * 2. R = k' * G
 * 3. k = R.y is even ? k' : -k'
 * 4. e = hashMessageLegacy(message, pk, R.x, networkId)
 * 5. s = k + e * sk (mod scalar order)
 * 6. Signature = { r: R.x, s }
 */
function signLegacy(
  message: HashInputLegacy,
  privateKey: bigint,
  networkId: 'mainnet' | 'testnet',
): MinaSignature {
  const pubPoint = MINA_GENERATOR.multiply(privateKey)
  const publicKey = { x: pubPoint.x, y: pubPoint.y }

  const kPrime = deriveNonceLegacy(message, publicKey, privateKey, networkId)
  if (kPrime === 0n) {
    throw new ChainKitError(ErrorCode.SIGNING_FAILED, 'Derived nonce is zero')
  }

  const R = MINA_GENERATOR.multiply(kPrime)
  const rx = R.x
  const ry = R.y

  // Negate k if R.y is odd (we want even y)
  const k = fieldIsEven(ry) ? kPrime : scalarNegate(kPrime)

  const e = hashMessageLegacy(message, publicKey, rx, networkId)
  const s = scalarAdd(k, scalarMul(e, privateKey))

  return {
    field: rx.toString(),
    scalar: s.toString(),
  }
}

/**
 * Decode a Mina address to extract the x-coordinate and y-parity.
 */
function decodeMinaAddress(address: string): { x: bigint; isOdd: boolean } {
  try {
    const { xCoordLE, isOdd } = minaBase58CheckDecode(address)
    const x = le32ToBigint(xCoordLE)
    return { x, isOdd }
  } catch {
    // Fallback: decode the base58 payload without checksum validation.
    const decoded = base58.decode(address)
    if (decoded.length >= 36) {
      const xCoordLE = decoded.slice(3, 35)
      const isOdd = decoded[35] === 0x01
      const x = le32ToBigint(xCoordLE)
      return { x, isOdd }
    }
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Cannot decode address: ${address}`)
  }
}

/**
 * Build the legacy hash input for a payment transaction.
 *
 * Following Mina's legacy format from o1js sign-legacy.ts:
 *
 * Common fields:
 *   fee (uint64 bits) + fee_token_id (legacy) + fee_payer (pubkey legacy)
 *   + nonce (uint32 bits) + valid_until (uint32 bits) + memo (bits)
 *
 * Body fields:
 *   tag (3 bits) + source (pubkey legacy) + receiver (pubkey legacy)
 *   + token_id (legacy) + amount (uint64 bits) + token_locked (1 bit = false)
 */
function buildPaymentInputLegacy(tx: {
  feePayer: { x: bigint; isOdd: boolean }
  source: { x: bigint; isOdd: boolean }
  receiver: { x: bigint; isOdd: boolean }
  fee: bigint
  nonce: bigint
  validUntil: bigint
  memo: string
  amount: bigint
}): HashInputLegacy {
  // Common fields
  const common = [
    HashInputLegacyOps.bits(uint64ToBits(tx.fee)),
    HashInputLegacyOps.bits(LEGACY_TOKEN_ID),
    publicKeyToInputLegacy(tx.feePayer.x, tx.feePayer.isOdd),
    HashInputLegacyOps.bits(uint32ToBits(tx.nonce)),
    HashInputLegacyOps.bits(uint32ToBits(tx.validUntil)),
    HashInputLegacyOps.bits(memoToBits(tx.memo)),
  ].reduce(HashInputLegacyOps.append)

  // Body fields
  const body = [
    HashInputLegacyOps.bits(tagToInputBits('Payment')),
    publicKeyToInputLegacy(tx.source.x, tx.source.isOdd),
    publicKeyToInputLegacy(tx.receiver.x, tx.receiver.isOdd),
    HashInputLegacyOps.bits(LEGACY_TOKEN_ID),
    HashInputLegacyOps.bits(uint64ToBits(tx.amount)),
    HashInputLegacyOps.bits([false]), // token_locked
  ].reduce(HashInputLegacyOps.append)

  return HashInputLegacyOps.append(common, body)
}

/**
 * Mina signer implementing the ChainSigner interface.
 *
 * Uses the Pallas curve from the Pasta curves family.
 * Addresses are base58check encoded with the B62 prefix.
 *
 * Transaction signing uses Poseidon hash with Mina's exact Kimchi parameters
 * and the legacy hash input format, matching the o1js reference implementation.
 *
 * Signature scheme: Schnorr on Pallas
 *   s = k + e * sk (mod scalar order)
 * where k is derived via blake2b, e is the Poseidon hash of the transaction.
 */
export class MinaSigner implements ChainSigner {
  private readonly network: 'mainnet' | 'testnet'

  constructor(network?: 'mainnet' | 'testnet') {
    this.network = network ?? 'mainnet'
  }

  getDefaultHdPath(): string {
    return "m/44'/12586'/0'/0/0"
  }

  generateMnemonic(strength?: number): string {
    return generateMnemonic(strength)
  }

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

    const pubPoint = MINA_GENERATOR.multiply(pk)
    const x = pubPoint.x
    const y = pubPoint.y

    const isOdd = y % 2n === 1n
    const xBytes = bigintToLE32(x)

    return minaBase58CheckEncode(MINA_ADDRESS_VERSION, xBytes, isOdd)
  }

  /**
   * Validate a Mina address.
   */
  validateAddress(address: string): boolean {
    if (!address.startsWith('B62')) return false

    try {
      const { version, xCoordLE } = minaBase58CheckDecode(address)
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
   * Sign a Mina payment transaction using Schnorr signature on Pallas curve.
   *
   * Uses the legacy hash input format and Poseidon hash with Mina's exact
   * Kimchi parameters, matching the o1js reference implementation.
   *
   * Returns a JSON string containing { signature: { field, scalar }, payment }.
   */
  async signTransaction(params: SignTransactionParams): Promise<string> {
    const { privateKey, tx } = params
    const pkHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
    const pkBytes = hexToBytes(pkHex)
    try {
    const pk = bytesToNumberBE(pkBytes)

    if (pk === 0n || pk >= PALLAS_ORDER) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        'Private key out of valid range',
      )
    }

    const from = tx.from ?? this.getAddress(privateKey)
    const to = tx.to
    const amount = tx.value ?? tx.amount ?? '0'
    const fee = tx.fee?.fee ?? '10000000'
    const nonce = tx.nonce ?? 0
    const memo = tx.memo ?? ''
    const validUntil = (tx.extra?.validUntil as number) ?? 4294967295
    const network = (tx.extra?.network as 'mainnet' | 'testnet') ?? this.network

    // Decode sender and receiver addresses
    const sender = decodeMinaAddress(from)
    const receiver = decodeMinaAddress(to)

    // Build legacy hash input
    const input = buildPaymentInputLegacy({
      feePayer: sender,
      source: sender,
      receiver,
      fee: BigInt(fee),
      nonce: BigInt(nonce),
      validUntil: BigInt(validUntil),
      memo,
      amount: BigInt(amount),
    })

    // Sign using the legacy Schnorr scheme
    const signature = signLegacy(input, pk, network)

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
    } finally {
      pkBytes.fill(0)
    }
  }

  /**
   * Sign a pre-computed transaction hash directly.
   *
   * This is useful when the Poseidon hash has been computed externally.
   * The hash should be a Pallas field element represented as a decimal string
   * or 32-byte big-endian hex string.
   */
  async signTransactionHash(privateKey: string, hash: string): Promise<string> {
    const pkHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
    const pkBytes = hexToBytes(pkHex)
    try {
    const pk = bytesToNumberBE(pkBytes)

    if (pk === 0n || pk >= PALLAS_ORDER) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        'Private key out of valid range',
      )
    }

    // Interpret hash as a field element (the "e" in the signature)
    let e: bigint
    if (hash.startsWith('0x') || /^[0-9a-fA-F]{64}$/.test(hash)) {
      const hashHex = hash.startsWith('0x') ? hash.slice(2) : hash
      e = bytesToNumberBE(hexToBytes(hashHex))
    } else {
      e = BigInt(hash)
    }

    // Compute R = kPrime * G with a deterministic nonce
    const pubPoint = MINA_GENERATOR.multiply(pk)
    const hashBytes = new Uint8Array(numberToBytesBE(e, 32))
    const nonceInput = blake2b(
      Uint8Array.from([...hashBytes, ...new Uint8Array(numberToBytesBE(pk, 32))]),
      { dkLen: 32 },
    )
    const mutableNonce = new Uint8Array(nonceInput)
    mutableNonce[mutableNonce.length - 1] &= 0x3f
    let kPrime = 0n
    for (let i = 0; i < mutableNonce.length; i++) {
      kPrime += BigInt(mutableNonce[i]) << BigInt(8 * i)
    }
    kPrime = scalarMod(kPrime)
    if (kPrime === 0n) kPrime = 1n

    const R = MINA_GENERATOR.multiply(kPrime)
    const k = fieldIsEven(R.y) ? kPrime : scalarNegate(kPrime)
    const s = scalarAdd(k, scalarMul(e, pk))

    return JSON.stringify({
      field: R.x.toString(),
      scalar: s.toString(),
    })
    } finally {
      pkBytes.fill(0)
    }
  }

  /**
   * Sign an arbitrary message using Schnorr signature on Pallas curve.
   *
   * Uses Poseidon hash with the legacy format for message hashing,
   * matching Mina's message signing convention.
   *
   * Returns a JSON string containing { field, scalar } signature.
   */
  async signMessage(params: SignMessageParams): Promise<string> {
    const { privateKey, message } = params
    const pkHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
    const pkBytes = hexToBytes(pkHex)
    try {
    const pk = bytesToNumberBE(pkBytes)

    if (pk === 0n || pk >= PALLAS_ORDER) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        'Private key out of valid range',
      )
    }

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Convert message to legacy hash input (as bits)
    const bits: boolean[] = []
    for (const byte of msgBytes) {
      for (let j = 0; j < 8; j++) {
        bits.push(((byte >> j) & 1) === 1)
      }
    }
    const input: HashInputLegacy = { fields: [], bits }

    const signature = signLegacy(input, pk, this.network)

    return JSON.stringify(signature)
    } finally {
      pkBytes.fill(0)
    }
  }
}
