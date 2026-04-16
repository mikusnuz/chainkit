import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import { keccak_256 } from '@noble/hashes/sha3'
import { blake2b } from '@noble/hashes/blake2b'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import * as secp256k1 from '@noble/secp256k1'

// @noble/secp256k1 v2 requires manually setting the hmac function
secp256k1.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) => {
  return hmac(sha256, k, secp256k1.etc.concatBytes(...m))
}

/** Default VeChain BIP44 HD path */
export const VECHAIN_HD_PATH = "m/44'/818'/0'/0/0"

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
 * Compute EIP-55 checksum address (VeChain uses the same format).
 */
function toChecksumAddress(address: string): string {
  const addr = stripHexPrefix(address).toLowerCase()
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(addr)))

  let checksummed = '0x'
  for (let i = 0; i < 40; i++) {
    if (parseInt(hash[i], 16) >= 8) {
      checksummed += addr[i].toUpperCase()
    } else {
      checksummed += addr[i]
    }
  }
  return checksummed
}

/**
 * RLP encode a single item (string/bytes or list).
 */
function rlpEncode(input: Uint8Array | Uint8Array[]): Uint8Array {
  if (input instanceof Uint8Array) {
    return rlpEncodeBytes(input)
  }
  // Encode list
  const encoded = input.map((item) => rlpEncode(item))
  const totalLength = encoded.reduce((sum, buf) => sum + buf.length, 0)
  const lengthPrefix = rlpEncodeLength(totalLength, 192)
  const result = new Uint8Array(lengthPrefix.length + totalLength)
  result.set(lengthPrefix, 0)
  let offset = lengthPrefix.length
  for (const buf of encoded) {
    result.set(buf, offset)
    offset += buf.length
  }
  return result
}

function rlpEncodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] < 128) {
    return bytes
  }
  if (bytes.length <= 55) {
    const result = new Uint8Array(1 + bytes.length)
    result[0] = 128 + bytes.length
    result.set(bytes, 1)
    return result
  }
  const lenBytes = toMinimalBytes(bytes.length)
  const result = new Uint8Array(1 + lenBytes.length + bytes.length)
  result[0] = 183 + lenBytes.length
  result.set(lenBytes, 1)
  result.set(bytes, 1 + lenBytes.length)
  return result
}

function rlpEncodeLength(length: number, offset: number): Uint8Array {
  if (length <= 55) {
    return new Uint8Array([offset + length])
  }
  const lenBytes = toMinimalBytes(length)
  const result = new Uint8Array(1 + lenBytes.length)
  result[0] = offset + 55 + lenBytes.length
  result.set(lenBytes, 1)
  return result
}

function toMinimalBytes(value: number): Uint8Array {
  if (value === 0) return new Uint8Array([])
  const hex = value.toString(16)
  const padded = hex.length % 2 === 0 ? hex : '0' + hex
  return hexToBytes(padded)
}

/**
 * Convert a number to minimal bytes for RLP encoding.
 */
function numberToMinimalBytes(num: number): Uint8Array {
  if (num === 0) return new Uint8Array([])
  let hex = num.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return hexToBytes(hex)
}

/**
 * Convert a decimal string to minimal bytes for RLP encoding.
 */
function decimalToMinimalBytes(dec: string): Uint8Array {
  const n = BigInt(dec)
  if (n === 0n) return new Uint8Array([])
  let hex = n.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return hexToBytes(hex)
}

/**
 * Convert a hex string (possibly with 0x prefix) to minimal bytes for RLP encoding.
 * Strips leading zeros.
 */
function hexToMinimalBytes(hex: string): Uint8Array {
  const stripped = stripHexPrefix(hex)
  if (stripped === '' || stripped === '0') return new Uint8Array([])
  let clean = stripped.replace(/^0+/, '')
  if (clean === '') return new Uint8Array([])
  if (clean.length % 2 !== 0) clean = '0' + clean
  return hexToBytes(clean)
}

/**
 * Convert a hex string to a fixed-length byte array, preserving leading zeros.
 * Used for fields like blockRef that must be exactly N bytes.
 */
function hexToFixedBytes(hex: string, length: number): Uint8Array {
  const stripped = stripHexPrefix(hex)
  if (stripped === '' || stripped === '0') return new Uint8Array(length)
  const padded = stripped.padStart(length * 2, '0')
  return hexToBytes(padded)
}

/**
 * VeChain signer implementing the ChainSigner interface.
 *
 * Key derivation uses the same secp256k1 + keccak256 scheme as Ethereum,
 * but with VeChain's BIP44 HD path (m/44'/818'/0'/0/0).
 *
 * Transaction signing uses VeChain's native format:
 * - RLP encoding for the transaction body
 * - blake2b-256 for the signing hash (NOT keccak256)
 * - secp256k1 for the signature
 * - Signature is included as the last field in the RLP-encoded transaction
 */
export class VeChainSigner implements ChainSigner {
  /**
   * @param _network - Accepted for interface consistency but not used for address generation.
   */
  constructor(_network?: 'mainnet' | 'testnet') {
    // Network does not affect EVM-compatible address generation
  }

  /**
   * Get the default BIP44 HD derivation path for VeChain.
   */
  getDefaultHdPath(): string {
    return "m/44'/818'/0'/0/0"
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
   * Derive a private key from a mnemonic using VeChain's BIP44 HD path.
   * Default path: m/44'/818'/0'/0/0
   * Returns a '0x'-prefixed hex string.
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return addHexPrefix(privateKeyHex)
  }

  /**
   * Get the VeChain address for a given private key.
   * VeChain uses the same address derivation as Ethereum:
   * keccak256(uncompressed_pubkey[1:])[-20:]
   * Returns an EIP-55 checksummed address.
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

    // Take the keccak256 hash of the public key bytes (without the 04 prefix)
    const hash = keccak_256(publicKey.slice(1))

    // Take the last 20 bytes as the address
    const addressBytes = hash.slice(-20)
    return toChecksumAddress(bytesToHex(addressBytes))
  }

  /**
   * Sign a VeChain transaction.
   *
   * VeChain transaction body is RLP-encoded as:
   * [chainTag, blockRef, expiration, [clauses...], gasPriceCoef, gas, dependsOn, nonce, reserved]
   *
   * Each clause is: [to, value, data]
   *
   * Signing process:
   * 1. RLP encode the body (all fields except signature)
   * 2. Hash the RLP bytes with blake2b-256
   * 3. Sign the hash with secp256k1
   * 4. RLP encode the full transaction with signature as the last field
   *
   * The transaction uses the UnsignedTx interface where:
   * - extra.chainTag: chain tag byte (e.g., 0x27 for mainnet)
   * - extra.blockRef: block reference (8 bytes hex)
   * - extra.expiration: block expiration (default 720)
   * - extra.gasPriceCoef: gas price coefficient (default 0)
   * - extra.nonce: random nonce hex string (generated if not provided)
   * - fee.gas: gas limit
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    const chainTag = (tx.extra?.chainTag as number) ?? 0x27
    const blockRef = (tx.extra?.blockRef as string) ?? '0x0000000000000000'
    const expiration = (tx.extra?.expiration as number) ?? 720
    const gasPriceCoef = (tx.extra?.gasPriceCoef as number) ?? 0
    const gas = tx.fee?.gas ? parseInt(tx.fee.gas as string, 10) : 21000
    const dependsOn = (tx.extra?.dependsOn as string) ?? null
    // VeChain nonce is random (not sequential like Ethereum) — generate 8 random bytes if not provided
    const nonce = (tx.extra?.nonce as string) ?? '0x' + bytesToHex(randomBytes(8))

    // Build clause: [to, value, data]
    const toBytes = hexToBytes(stripHexPrefix(tx.to))
    const rawValue = tx.value ?? tx.amount ?? '0'
    const valueBytes = rawValue.startsWith('0x')
      ? hexToMinimalBytes(rawValue)
      : decimalToMinimalBytes(rawValue)
    const dataBytes = tx.data ? hexToBytes(stripHexPrefix(tx.data as string)) : new Uint8Array([])

    // Encode clause as an RLP list of its three fields
    const clauseEncoded = rlpEncode([toBytes, valueBytes, dataBytes])

    // Wrap clauses in an outer list (single clause for basic transfers)
    // The clauses field is a list-of-lists, so we wrap the encoded clause in another list
    const clausesListPrefix = rlpEncodeLength(clauseEncoded.length, 192)
    const clausesList = new Uint8Array(clausesListPrefix.length + clauseEncoded.length)
    clausesList.set(clausesListPrefix, 0)
    clausesList.set(clauseEncoded, clausesListPrefix.length)

    // Build the RLP-encoded transaction body (unsigned)
    // Each scalar field is individually RLP-encoded, then all are wrapped in an outer list
    const encodedFields: Uint8Array[] = [
      rlpEncode(numberToMinimalBytes(chainTag)),          // chainTag
      rlpEncode(hexToFixedBytes(blockRef, 8)),            // blockRef (8 bytes, preserve leading zeros)
      rlpEncode(numberToMinimalBytes(expiration)),        // expiration
      clausesList,                                        // clauses (already list-encoded)
      rlpEncode(numberToMinimalBytes(gasPriceCoef)),      // gasPriceCoef
      rlpEncode(numberToMinimalBytes(gas)),                // gas
      dependsOn                                           // dependsOn
        ? rlpEncode(hexToBytes(stripHexPrefix(dependsOn)))
        : rlpEncode(new Uint8Array([])),
      rlpEncode(hexToMinimalBytes(nonce)),                // nonce
      new Uint8Array([0xc0]),                             // reserved (empty list)
    ]

    // Concatenate all encoded fields and wrap with list prefix
    const bodyPayloadLength = encodedFields.reduce((sum, buf) => sum + buf.length, 0)
    const bodyPrefix = rlpEncodeLength(bodyPayloadLength, 192)
    const body = new Uint8Array(bodyPrefix.length + bodyPayloadLength)
    body.set(bodyPrefix, 0)
    let offset = bodyPrefix.length
    for (const field of encodedFields) {
      body.set(field, offset)
      offset += field.length
    }

    // Hash with blake2b-256 (VeChain's transaction hash algorithm)
    const signingHash = blake2b(body, { dkLen: 32 })

    // Sign with secp256k1
    const signature = secp256k1.sign(signingHash, pkBytes)

    // VeChain signature: r (32 bytes) + s (32 bytes) + recovery (1 byte)
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')
    const recovery = signature.recovery
    const sigBytes = hexToBytes(rHex + sHex + recovery.toString(16).padStart(2, '0'))

    // Build the signed transaction: re-encode body fields + signature field in one RLP list
    const encodedSig = rlpEncode(sigBytes)
    const signedPayloadLength = bodyPayloadLength + encodedSig.length
    const signedPrefix = rlpEncodeLength(signedPayloadLength, 192)
    const signedTx = new Uint8Array(signedPrefix.length + signedPayloadLength)
    signedTx.set(signedPrefix, 0)
    let signedOffset = signedPrefix.length
    for (const field of encodedFields) {
      signedTx.set(field, signedOffset)
      signedOffset += field.length
    }
    signedTx.set(encodedSig, signedOffset)

    return addHexPrefix(bytesToHex(signedTx))
  }

  /**
   * Validate a VeChain address.
   * VeChain uses the same address format as Ethereum: 0x + 40 hex characters.
   */
  validateAddress(address: string): boolean {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false
    // If mixed case, verify EIP-55 checksum
    const lower = address.slice(2).toLowerCase()
    const upper = address.slice(2).toUpperCase()
    if (address.slice(2) !== lower && address.slice(2) !== upper) {
      return toChecksumAddress(address) === address
    }
    return true
  }

  /**
   * Sign an arbitrary message.
   * VeChain uses a similar prefix to Ethereum for personal signing.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    // Convert message to bytes
    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Hash the message with keccak256
    const msgHash = keccak_256(msgBytes)

    // Sign
    const signature = secp256k1.sign(msgHash, pkBytes)

    // Encode as r (32 bytes) + s (32 bytes) + v (1 byte)
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')
    const v = signature.recovery + 27

    return addHexPrefix(rHex + sHex + v.toString(16).padStart(2, '0'))
  }
}
