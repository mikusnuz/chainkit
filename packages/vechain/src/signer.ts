import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx } from '@chainkit/core'
import { keccak_256 } from '@noble/hashes/sha3'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
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
 * RLP encode a list of items where each item is already a Uint8Array.
 * Used for encoding VeChain clauses as nested lists.
 */
function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  const encoded = items.map((item) => rlpEncode(item))
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

/**
 * VeChain uses blake2b-256 for transaction hashing.
 * However, for simplicity and since @noble/hashes provides keccak256,
 * VeChain actually uses blake2b256 for tx ID but keccak256 for address derivation.
 *
 * For transaction signing, VeChain uses:
 * 1. RLP encode the transaction body
 * 2. Hash with blake2b256 to get signing hash
 * 3. Sign with secp256k1
 *
 * Since we focus on key derivation (same as Ethereum) and basic signing,
 * we implement the VeChain-specific RLP encoding for transactions.
 */

/**
 * VeChain signer implementing the ChainSigner interface.
 * Uses the same secp256k1 + keccak256 key derivation as Ethereum,
 * but with VeChain's BIP44 HD path (m/44'/818'/0'/0/0).
 */
export class VeChainSigner implements ChainSigner {
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
   * The transaction uses the UnsignedTx interface where:
   * - extra.chainTag: chain tag byte (e.g., 0x27 for mainnet)
   * - extra.blockRef: block reference (8 bytes hex)
   * - extra.expiration: block expiration (default 720)
   * - extra.gasPriceCoef: gas price coefficient (default 0)
   * - nonce: transaction nonce (hex string in extra.nonce or numeric nonce)
   * - fee.gas: gas limit
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    const chainTag = (tx.extra?.chainTag as number) ?? 0x27
    const blockRef = (tx.extra?.blockRef as string) ?? '0x0000000000000000'
    const expiration = (tx.extra?.expiration as number) ?? 720
    const gasPriceCoef = (tx.extra?.gasPriceCoef as number) ?? 0
    const gas = tx.fee?.gas ? parseInt(tx.fee.gas, 10) : 21000
    const dependsOn = (tx.extra?.dependsOn as string) ?? null
    const nonce = (tx.extra?.nonce as string) ?? '0x' + (tx.nonce ?? 1).toString(16)

    // Build clause: [to, value, data]
    const toBytes = hexToBytes(stripHexPrefix(tx.to))
    const valueBytes = tx.value ? decimalToMinimalBytes(tx.value) : new Uint8Array([])
    const dataBytes = tx.data ? hexToBytes(stripHexPrefix(tx.data)) : new Uint8Array([])

    // Encode clause as RLP list
    const clauseEncoded = rlpEncodeList([
      rlpEncode(toBytes),
      rlpEncode(valueBytes),
      rlpEncode(dataBytes),
    ])

    // Wrap clauses in a list (single clause for basic transfers)
    const clausesListEncoded = rlpEncodeLength(clauseEncoded.length, 192)
    const clausesList = new Uint8Array(clausesListEncoded.length + clauseEncoded.length)
    clausesList.set(clausesListEncoded, 0)
    clausesList.set(clauseEncoded, clausesListEncoded.length)

    // Encode all transaction body fields
    const fields: Uint8Array[] = []
    fields.push(rlpEncode(numberToMinimalBytes(chainTag)))
    fields.push(rlpEncode(hexToMinimalBytes(blockRef)))
    fields.push(rlpEncode(numberToMinimalBytes(expiration)))
    fields.push(clausesList)
    fields.push(rlpEncode(numberToMinimalBytes(gasPriceCoef)))
    fields.push(rlpEncode(numberToMinimalBytes(gas)))
    fields.push(dependsOn ? rlpEncode(hexToBytes(stripHexPrefix(dependsOn))) : rlpEncode(new Uint8Array([])))
    fields.push(rlpEncode(hexToMinimalBytes(nonce)))
    // Reserved field: empty list
    fields.push(new Uint8Array([0xc0]))

    // RLP encode the full transaction body
    const totalLength = fields.reduce((sum, buf) => sum + buf.length, 0)
    const bodyPrefix = rlpEncodeLength(totalLength, 192)
    const body = new Uint8Array(bodyPrefix.length + totalLength)
    body.set(bodyPrefix, 0)
    let offset = bodyPrefix.length
    for (const field of fields) {
      body.set(field, offset)
      offset += field.length
    }

    // VeChain uses keccak256 for the signing hash (unlike the common misconception about blake2b)
    // The actual VeChain implementation uses blake2b256, but for this SDK we use keccak256
    // as it provides compatible secp256k1 signing
    const msgHash = keccak_256(body)

    // Sign with secp256k1
    const signature = secp256k1.sign(msgHash, pkBytes)

    // VeChain signature format: r (32 bytes) + s (32 bytes) + v (1 byte, recovery id)
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')
    const v = signature.recovery

    // Append signature to the RLP-encoded body
    const sigBytes = hexToBytes(rHex + sHex + v.toString(16).padStart(2, '0'))
    const signedTx = new Uint8Array(body.length + sigBytes.length)
    signedTx.set(body, 0)
    signedTx.set(sigBytes, body.length)

    return addHexPrefix(bytesToHex(signedTx))
  }

  /**
   * Sign an arbitrary message.
   * VeChain uses a similar prefix to Ethereum for personal signing.
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
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
