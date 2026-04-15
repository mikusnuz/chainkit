import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import { blake2b } from '@noble/hashes/blake2b'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as secp256k1 from '@noble/secp256k1'

// @noble/secp256k1 v2 requires manually setting the hmac function
secp256k1.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) => {
  return hmac(sha256, k, secp256k1.etc.concatBytes(...m))
}

/**
 * Filecoin base32 lower alphabet (RFC 4648 lowercase, no padding).
 */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * Encode bytes to base32 lowercase without padding (Filecoin standard).
 */
function base32Encode(data: Uint8Array): string {
  let result = ''
  let bits = 0
  let buffer = 0

  for (const byte of data) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += BASE32_ALPHABET[(buffer >> bits) & 0x1f]
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f]
  }

  return result
}

/**
 * Decode base32 lowercase string to bytes (no padding).
 */
function base32Decode(str: string): Uint8Array {
  const lookup: Record<string, number> = {}
  for (let i = 0; i < BASE32_ALPHABET.length; i++) {
    lookup[BASE32_ALPHABET[i]] = i
  }

  let bits = 0
  let buffer = 0
  const bytes: number[] = []

  for (const ch of str) {
    const val = lookup[ch]
    if (val === undefined) {
      throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Invalid base32 character: ${ch}`)
    }
    buffer = (buffer << 5) | val
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }

  return new Uint8Array(bytes)
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
 * Compute the 4-byte Filecoin address checksum.
 * Checksum = blake2b-32(protocol_byte || payload_bytes)
 * where blake2b-32 means blake2b with 4-byte (32-bit) output.
 */
function computeChecksum(protocol: number, payload: Uint8Array): Uint8Array {
  const input = new Uint8Array(1 + payload.length)
  input[0] = protocol
  input.set(payload, 1)
  return blake2b(input, { dkLen: 4 })
}

/**
 * Encode a Filecoin f1 (secp256k1) address from a public key.
 * Format: "f1" + base32lower(blake2b-160(uncompressed_pubkey) + checksum)
 */
function publicKeyToAddress(publicKey: Uint8Array): string {
  // blake2b-160 (20 bytes) of the uncompressed public key
  const payload = blake2b(publicKey, { dkLen: 20 })

  // 4-byte checksum of (protocol=1 || payload)
  const checksum = computeChecksum(1, payload)

  // Concatenate payload + checksum
  const combined = new Uint8Array(payload.length + checksum.length)
  combined.set(payload, 0)
  combined.set(checksum, payload.length)

  return 'f1' + base32Encode(combined)
}

/**
 * Validate a Filecoin address format.
 */
function isValidFilecoinAddress(address: string): boolean {
  if (!address.startsWith('f') && !address.startsWith('t')) return false
  if (address.length < 3) return false

  const network = address[0] // 'f' for mainnet, 't' for testnet
  const protocol = parseInt(address[1], 10)

  if (protocol < 0 || protocol > 3) return false

  // For f0 addresses (ID addresses)
  if (protocol === 0) {
    return /^[ft]0\d+$/.test(address)
  }

  // For f1 (secp256k1)
  if (protocol === 1) {
    try {
      const encoded = address.slice(2)
      const decoded = base32Decode(encoded)
      // payload (20 bytes) + checksum (4 bytes) = 24 bytes
      if (decoded.length !== 24) return false
      const payload = decoded.slice(0, 20)
      const checksum = decoded.slice(20, 24)
      const expected = computeChecksum(1, payload)
      return bytesToHex(checksum) === bytesToHex(expected)
    } catch {
      return false
    }
  }

  return true
}

/**
 * CBOR-encode a Filecoin message for signing.
 * Filecoin messages are CBOR arrays with 10 fields:
 * [Version, To, From, Nonce, Value, GasLimit, GasFeeCap, GasPremium, Method, Params]
 */
function cborEncodeMessage(msg: {
  to: string
  from: string
  value: string
  method: number
  nonce: number
  gasLimit: number
  gasFeeCap: string
  gasPremium: string
}): Uint8Array {
  const parts: Uint8Array[] = []

  // Array header: 10 elements
  parts.push(new Uint8Array([0x8a]))

  // 0: Version (always 0)
  parts.push(cborEncodeUint(0))

  // 1: To (address bytes)
  parts.push(cborEncodeBytes(addressToBytes(msg.to)))

  // 2: From (address bytes)
  parts.push(cborEncodeBytes(addressToBytes(msg.from)))

  // 3: Nonce
  parts.push(cborEncodeUint(msg.nonce))

  // 4: Value (BigInt serialized as bytes)
  parts.push(cborEncodeBytes(bigintToBytes(msg.value)))

  // 5: GasLimit
  parts.push(cborEncodeUint(msg.gasLimit))

  // 6: GasFeeCap (BigInt serialized as bytes)
  parts.push(cborEncodeBytes(bigintToBytes(msg.gasFeeCap)))

  // 7: GasPremium (BigInt serialized as bytes)
  parts.push(cborEncodeBytes(bigintToBytes(msg.gasPremium)))

  // 8: Method (0 = transfer)
  parts.push(cborEncodeUint(msg.method))

  // 9: Params (empty bytes for transfer)
  parts.push(cborEncodeBytes(new Uint8Array(0)))

  // Calculate total length
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }

  return result
}

/**
 * CBOR-encode an unsigned integer.
 */
function cborEncodeUint(value: number): Uint8Array {
  if (value < 24) {
    return new Uint8Array([value])
  }
  if (value < 256) {
    return new Uint8Array([0x18, value])
  }
  if (value < 65536) {
    return new Uint8Array([0x19, (value >> 8) & 0xff, value & 0xff])
  }
  if (value < 4294967296) {
    return new Uint8Array([
      0x1a,
      (value >> 24) & 0xff,
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    ])
  }
  // 8-byte integer
  const buf = new Uint8Array(9)
  buf[0] = 0x1b
  const big = BigInt(value)
  for (let i = 7; i >= 0; i--) {
    buf[8 - i] = Number((big >> BigInt(i * 8)) & 0xffn)
  }
  return buf
}

/**
 * CBOR-encode a byte string.
 */
function cborEncodeBytes(data: Uint8Array): Uint8Array {
  const header = cborEncodeLength(2, data.length) // major type 2 = byte string
  const result = new Uint8Array(header.length + data.length)
  result.set(header, 0)
  result.set(data, header.length)
  return result
}

/**
 * CBOR-encode a length with a major type.
 */
function cborEncodeLength(majorType: number, length: number): Uint8Array {
  const mt = majorType << 5
  if (length < 24) {
    return new Uint8Array([mt | length])
  }
  if (length < 256) {
    return new Uint8Array([mt | 24, length])
  }
  if (length < 65536) {
    return new Uint8Array([mt | 25, (length >> 8) & 0xff, length & 0xff])
  }
  return new Uint8Array([
    mt | 26,
    (length >> 24) & 0xff,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  ])
}

/**
 * Convert a Filecoin address to its protocol-prefixed byte representation.
 * For on-chain CBOR encoding, address is protocol_byte + payload.
 */
function addressToBytes(address: string): Uint8Array {
  const network = address[0]
  if (network !== 'f' && network !== 't') {
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Invalid Filecoin address prefix: ${network}`)
  }

  const protocol = parseInt(address[1], 10)

  if (protocol === 0) {
    // ID address: protocol byte + leb128-encoded ID
    const id = parseInt(address.slice(2), 10)
    const leb = leb128Encode(id)
    const result = new Uint8Array(1 + leb.length)
    result[0] = 0
    result.set(leb, 1)
    return result
  }

  if (protocol === 1 || protocol === 2) {
    // secp256k1 or actor: protocol byte + 20-byte payload
    const encoded = address.slice(2)
    const decoded = base32Decode(encoded)
    // First 20 bytes = payload, last 4 bytes = checksum
    const payload = decoded.slice(0, 20)
    const result = new Uint8Array(1 + payload.length)
    result[0] = protocol
    result.set(payload, 1)
    return result
  }

  if (protocol === 3) {
    // BLS: protocol byte + 48-byte payload
    const encoded = address.slice(2)
    const decoded = base32Decode(encoded)
    const payload = decoded.slice(0, 48)
    const result = new Uint8Array(1 + payload.length)
    result[0] = 3
    result.set(payload, 1)
    return result
  }

  throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Unsupported Filecoin address protocol: ${protocol}`)
}

/**
 * Encode a number as unsigned LEB128.
 */
function leb128Encode(value: number): Uint8Array {
  if (value === 0) return new Uint8Array([0])
  const bytes: number[] = []
  let v = value
  while (v > 0) {
    let byte = v & 0x7f
    v >>= 7
    if (v > 0) byte |= 0x80
    bytes.push(byte)
  }
  return new Uint8Array(bytes)
}

/**
 * Convert a decimal string (attoFIL) to a big-endian byte array.
 * Filecoin uses big-int encoding for value fields.
 * Returns empty bytes for "0".
 */
function bigintToBytes(value: string): Uint8Array {
  const n = BigInt(value)
  if (n === 0n) return new Uint8Array(0)

  let hex = n.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  const bytes = hexToBytes(hex)

  // Filecoin BigInt: first byte is sign (0x00 = positive), followed by big-endian bytes
  const result = new Uint8Array(1 + bytes.length)
  result[0] = 0x00 // positive sign
  result.set(bytes, 1)
  return result
}

/**
 * Filecoin signer implementing the ChainSigner interface.
 * Supports BIP39/BIP32 key derivation, secp256k1 signing,
 * and Filecoin transaction message construction.
 */
export class FilecoinSigner implements ChainSigner {
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
   * Derive a private key from a mnemonic using a BIP44 HD path.
   * Default Filecoin path: m/44'/461'/0'/0/0
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return addHexPrefix(privateKeyHex)
  }

  /**
   * Get the Filecoin f1 address for a given private key.
   * Uses secp256k1 uncompressed public key -> blake2b-160 -> base32 encoding.
   */
  getAddress(privateKey: HexString): Address {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get the uncompressed public key (65 bytes: 04 + x + y)
    const publicKey = secp256k1.getPublicKey(pkBytes, false)

    return publicKeyToAddress(publicKey)
  }

  /**
   * Sign a Filecoin transaction message.
   *
   * The transaction is CBOR-encoded, hashed with blake2b-256, and signed with secp256k1.
   * Returns the signature as a hex string (65 bytes: r + s + v).
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    const gasLimit = tx.fee?.gasLimit ? parseInt(tx.fee.gasLimit, 10) : 1000000
    const gasFeeCap = (tx.fee?.gasFeeCap as string) ?? '0'
    const gasPremium = (tx.fee?.gasPremium as string) ?? '0'
    const method = (tx.extra?.method as number) ?? 0
    const nonce = tx.nonce ?? 0

    // CBOR-encode the message
    const cborMessage = cborEncodeMessage({
      to: tx.to,
      from: tx.from as string,
      value: (tx.value ?? tx.amount ?? "0") as string,
      method,
      nonce,
      gasLimit,
      gasFeeCap,
      gasPremium,
    })

    // CID prefix for signing: blake2b-256 hash with CID prefix
    // Filecoin uses CID v1 with dag-cbor (0x71) and blake2b-256 (0xb220, length 32)
    const CID_PREFIX = new Uint8Array([0x01, 0x71, 0xa0, 0xe4, 0x02, 0x20])
    const messageHash = blake2b(cborMessage, { dkLen: 32 })

    // The signing payload is the blake2b-256 of (CID_PREFIX + messageHash)
    const sigInput = new Uint8Array(CID_PREFIX.length + messageHash.length)
    sigInput.set(CID_PREFIX, 0)
    sigInput.set(messageHash, CID_PREFIX.length)
    const sigDigest = blake2b(sigInput, { dkLen: 32 })

    // Sign with secp256k1
    const signature = secp256k1.sign(sigDigest, pkBytes)

    // Filecoin signature format: r (32 bytes) + s (32 bytes) + v (1 byte, recovery id)
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')
    const v = signature.recovery

    return addHexPrefix(rHex + sHex + v.toString(16).padStart(2, '0'))
  }

  /**
   * Validate a Filecoin address.
   * Supports f0 (ID), f1 (secp256k1), f2 (actor), f3 (BLS) address formats.
   */
  validateAddress(address: string): boolean {
    return isValidFilecoinAddress(address)
  }

  /**
   * Sign an arbitrary message.
   * The message is hashed with blake2b-256 and signed with secp256k1.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Hash the message with blake2b-256
    const msgHash = blake2b(msgBytes, { dkLen: 32 })

    // Sign
    const signature = secp256k1.sign(msgHash, pkBytes)

    // r (32 bytes) + s (32 bytes) + v (1 byte)
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')
    const v = signature.recovery

    return addHexPrefix(rHex + sHex + v.toString(16).padStart(2, '0'))
  }
}
