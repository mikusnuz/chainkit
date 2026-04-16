import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { keccak_256 } from '@noble/hashes/sha3'
import * as secp256k1 from '@noble/secp256k1'

// @noble/ed25519 v2 requires setting the sha512 hash function
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

// @noble/secp256k1 v2 requires manually setting the hmac function
secp256k1.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) => {
  return hmac(sha256, k, secp256k1.etc.concatBytes(...m))
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
 * BIP44 path regex: m / purpose' / coin_type' / account' / change' / index'
 * All segments must be hardened for ED25519 SLIP-0010.
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
      `Invalid derivation path: "${path}". Expected format: m/44'/3030'/0'/0'/0'`,
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

// ------- RLP Encoding (for EVM transaction signing) -------

function rlpEncode(input: Uint8Array | Uint8Array[]): Uint8Array {
  if (input instanceof Uint8Array) {
    return rlpEncodeBytes(input)
  }
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

function hexToMinimalBytes(hex: string): Uint8Array {
  const stripped = stripHexPrefix(hex)
  if (stripped === '' || stripped === '0') return new Uint8Array([])
  let clean = stripped.replace(/^0+/, '')
  if (clean === '') return new Uint8Array([])
  if (clean.length % 2 !== 0) clean = '0' + clean
  return hexToBytes(clean)
}

function decimalToMinimalBytes(dec: string): Uint8Array {
  const n = BigInt(dec)
  if (n === 0n) return new Uint8Array([])
  let hex = n.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return hexToBytes(hex)
}

function numberToMinimalBytes(num: number): Uint8Array {
  if (num === 0) return new Uint8Array([])
  let hex = num.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return hexToBytes(hex)
}

function bigintToMinimalBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([])
  let hex = n.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return hexToBytes(hex)
}

/**
 * RLP encode EIP-2930 (type 1) or EIP-1559 (type 2) fields with empty access list.
 */
function rlpEncodeEip1559Fields(fields: Uint8Array[]): Uint8Array {
  const encodedFields: Uint8Array[] = []
  for (let i = 0; i < fields.length - 1; i++) {
    encodedFields.push(rlpEncode(fields[i]))
  }
  // Access list: empty list = 0xc0
  encodedFields.push(new Uint8Array([0xc0]))

  const totalLength = encodedFields.reduce((sum, buf) => sum + buf.length, 0)
  const lengthPrefix = rlpEncodeLength(totalLength, 192)
  const result = new Uint8Array(lengthPrefix.length + totalLength)
  result.set(lengthPrefix, 0)
  let offset = lengthPrefix.length
  for (const buf of encodedFields) {
    result.set(buf, offset)
    offset += buf.length
  }
  return result
}

function rlpEncodeEip1559Signed(
  fields: Uint8Array[],
  v: Uint8Array,
  r: Uint8Array,
  s: Uint8Array,
): Uint8Array {
  const encodedFields: Uint8Array[] = []
  for (let i = 0; i < fields.length - 1; i++) {
    encodedFields.push(rlpEncode(fields[i]))
  }
  // Access list: empty list
  encodedFields.push(new Uint8Array([0xc0]))
  // v, r, s
  encodedFields.push(rlpEncode(v))
  encodedFields.push(rlpEncode(r))
  encodedFields.push(rlpEncode(s))

  const totalLength = encodedFields.reduce((sum, buf) => sum + buf.length, 0)
  const lengthPrefix = rlpEncodeLength(totalLength, 192)
  const result = new Uint8Array(lengthPrefix.length + totalLength)
  result.set(lengthPrefix, 0)
  let offset = lengthPrefix.length
  for (const buf of encodedFields) {
    result.set(buf, offset)
    offset += buf.length
  }
  return result
}

/**
 * Compute EIP-55 checksum address from a raw 20-byte hex address.
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
 * Default Hedera BIP44 derivation path for ED25519.
 * m/44'/3030'/0'/0'/0' -- all hardened per SLIP-0010 ED25519.
 */
export const HEDERA_DEFAULT_PATH = "m/44'/3030'/0'/0'/0'"

/**
 * Default Hedera ECDSA BIP44 derivation path for EVM relay mode.
 * m/44'/60'/0'/0/0 -- standard Ethereum path since ECDSA uses secp256k1.
 */
export const HEDERA_ECDSA_PATH = "m/44'/60'/0'/0/0"

/**
 * Hedera signer implementing the ChainSigner interface.
 * Uses ED25519 keys with SLIP-0010 derivation.
 * getAddress returns the hex-encoded ED25519 public key (used as account alias).
 */
export class HederaSigner implements ChainSigner {
  constructor(_network?: 'mainnet' | 'testnet') {}

  getDefaultHdPath(): string {
    return "m/44'/3030'/0'/0/0"
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
   * Get the Hedera address for a given private key.
   * Returns the hex-encoded ED25519 public key (used as account alias).
   * On Hedera, an actual account ID (0.0.XXXXX) must be created on-chain;
   * the public key serves as the alias for wallet derivation purposes.
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

    // Return hex-encoded public key as the account alias
    return bytesToHex(publicKey)
  }

  /**
   * Sign a Hedera transaction.
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

      // The transaction body to sign should be in tx.data (hex-encoded serialized body)
      if (!tx.data) {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'Transaction data (serialized transaction body) is required for Hedera signing',
        )
      }

      const messageBytes = hexToBytes(stripHexPrefix(tx.data as string))

      // Sign with ED25519
      const signature = ed25519.sign(messageBytes, pkBytes)

      return addHexPrefix(bytesToHex(signature))
    } finally {
      pkBytes.fill(0)
    }
  }

  /**
   * Validate a Hedera address.
   * Accepts both account ID format (0.0.XXXXX) and 64-char hex public key alias.
   */
  validateAddress(address: string): boolean {
    try {
      // Account ID format: 0.0.XXXXX
      if (/^\d+\.\d+\.\d+$/.test(address)) return true
      // Hex public key alias (64 hex chars)
      if (/^[0-9a-fA-F]{64}$/.test(address)) return true
      return false
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

/**
 * Hedera ECDSA signer for JSON-RPC Relay (EVM) mode.
 *
 * Uses secp256k1 keys with standard BIP32 derivation (same as Ethereum).
 * This signer produces EVM-compatible addresses and signed transactions
 * that can be broadcast via the Hedera JSON-RPC Relay (Hashio).
 *
 * Key differences from HederaSigner:
 * - Uses secp256k1 instead of ED25519
 * - Uses BIP32 derivation instead of SLIP-0010
 * - Returns EVM addresses (0x format) instead of public key aliases
 * - Signs EVM transactions (legacy or EIP-1559) instead of Hedera-native transactions
 */
export class HederaEcdsaSigner implements ChainSigner {
  constructor(_network?: 'mainnet' | 'testnet') {}

  getDefaultHdPath(): string {
    return "m/44'/3030'/0'/0/0"
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
   * Derive a secp256k1 private key from a mnemonic using BIP32.
   * Uses standard Ethereum-compatible BIP44 path (m/44'/60'/0'/0/0).
   * Returns a '0x'-prefixed hex string.
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return addHexPrefix(privateKeyHex)
  }

  /**
   * Get the EVM address for a given secp256k1 private key.
   * Returns an EIP-55 checksummed address (0x format).
   * On Hedera, this address can be used as an account alias with the EVM relay.
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
   * Sign an EVM transaction for the Hedera JSON-RPC Relay.
   *
   * Supports EIP-1559 (type 2) transactions when fee.maxFeePerGas is provided,
   * and legacy transactions as fallback.
   *
   * Required tx fields:
   * - to: recipient EVM address
   * - value: amount in weibars (10^-18 HBAR)
   * - nonce: transaction nonce
   * - extra.chainId: Hedera chain ID (296 for testnet, 295 for mainnet)
   *
   * Fee fields (EIP-1559):
   * - fee.maxFeePerGas: hex string
   * - fee.maxPriorityFeePerGas: hex string
   * - fee.gasLimit: hex string (default: 0xC350 = 50000 for Hedera transfers)
   *
   * Fee fields (legacy):
   * - fee.gasPrice: hex string
   * - fee.gasLimit: hex string
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

      const chainId = (tx.extra?.chainId as number) ?? 296  // Default to Hedera Testnet
      const nonce = tx.nonce ?? 0
      const to = hexToBytes(stripHexPrefix(tx.to))
      const value = tx.value ? decimalToMinimalBytes(tx.value) : new Uint8Array([])
      const data = tx.data ? hexToBytes(stripHexPrefix(tx.data as string)) : new Uint8Array([])

      const isEip1559 = tx.fee?.maxFeePerGas !== undefined

      if (isEip1559) {
        // EIP-1559 (Type 2) transaction
        const maxPriorityFeePerGas = tx.fee?.maxPriorityFeePerGas
          ? hexToMinimalBytes(tx.fee.maxPriorityFeePerGas as string)
          : new Uint8Array([])
        const maxFeePerGas = tx.fee?.maxFeePerGas
          ? hexToMinimalBytes(tx.fee.maxFeePerGas as string)
          : new Uint8Array([])
        // Hedera requires higher gas limit for transfers (not 21000 like Ethereum)
        const gasLimit = tx.fee?.gasLimit
          ? hexToMinimalBytes(tx.fee.gasLimit as string)
          : hexToMinimalBytes('0xC350') // 50000 default for Hedera

        const fields: Uint8Array[] = [
          numberToMinimalBytes(chainId),
          numberToMinimalBytes(nonce),
          maxPriorityFeePerGas,
          maxFeePerGas,
          gasLimit,
          to,
          value,
          data,
          new Uint8Array([]), // access list placeholder
        ]

        const rlpPayload = rlpEncodeEip1559Fields(fields)
        const signingPayload = new Uint8Array(1 + rlpPayload.length)
        signingPayload[0] = 0x02
        signingPayload.set(rlpPayload, 1)

        const msgHash = keccak_256(signingPayload)
        const signature = secp256k1.sign(msgHash, pkBytes)

        const r = signature.r
        const s = signature.s
        const v = signature.recovery

        let rHex = r.toString(16)
        if (rHex.length % 2 !== 0) rHex = '0' + rHex
        let sHex = s.toString(16)
        if (sHex.length % 2 !== 0) sHex = '0' + sHex

        const signedFields: Uint8Array[] = [
          numberToMinimalBytes(chainId),
          numberToMinimalBytes(nonce),
          maxPriorityFeePerGas,
          maxFeePerGas,
          gasLimit,
          to,
          value,
          data,
          new Uint8Array([]), // access list placeholder
        ]

        const vBytes = numberToMinimalBytes(v)
        const rBytes = hexToBytes(rHex)
        const sBytes = hexToBytes(sHex)

        const signedRlp = rlpEncodeEip1559Signed(signedFields, vBytes, rBytes, sBytes)
        const signedTx = new Uint8Array(1 + signedRlp.length)
        signedTx[0] = 0x02
        signedTx.set(signedRlp, 1)

        return addHexPrefix(bytesToHex(signedTx))
      } else {
        // Legacy transaction
        const gasPrice = tx.fee?.gasPrice
          ? hexToMinimalBytes(tx.fee.gasPrice as string)
          : new Uint8Array([])
        const gasLimit = tx.fee?.gasLimit
          ? hexToMinimalBytes(tx.fee.gasLimit as string)
          : hexToMinimalBytes('0xC350') // 50000 default for Hedera

        // EIP-155 signing: [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
        const signingFields: Uint8Array[] = [
          numberToMinimalBytes(nonce),
          gasPrice,
          gasLimit,
          to,
          value,
          data,
          numberToMinimalBytes(chainId),
          new Uint8Array([]),
          new Uint8Array([]),
        ]

        const signingRlp = rlpEncode(signingFields)
        const msgHash = keccak_256(signingRlp)
        const signature = secp256k1.sign(msgHash, pkBytes)

        const r = signature.r
        const s = signature.s
        // EIP-155: v = recovery + chainId * 2 + 35
        const vVal = signature.recovery + chainId * 2 + 35

        let rHex = r.toString(16)
        if (rHex.length % 2 !== 0) rHex = '0' + rHex
        let sHex = s.toString(16)
        if (sHex.length % 2 !== 0) sHex = '0' + sHex

        const signedFields: Uint8Array[] = [
          numberToMinimalBytes(nonce),
          gasPrice,
          gasLimit,
          to,
          value,
          data,
          numberToMinimalBytes(vVal),
          hexToBytes(rHex),
          hexToBytes(sHex),
        ]

        const signedRlp = rlpEncode(signedFields)
        return addHexPrefix(bytesToHex(signedRlp))
      }
    } finally {
      pkBytes.fill(0)
    }
  }

  /**
   * Validate an EVM address.
   * Checks for 0x prefix and 40 hex characters.
   */
  validateAddress(address: string): boolean {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false
    const lower = address.slice(2).toLowerCase()
    const upper = address.slice(2).toUpperCase()
    if (address.slice(2) !== lower && address.slice(2) !== upper) {
      return toChecksumAddress(address) === address
    }
    return true
  }

  /**
   * Sign an arbitrary message using EIP-191 personal_sign.
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

      const prefix = new TextEncoder().encode(
        `\x19Ethereum Signed Message:\n${msgBytes.length}`,
      )
      const prefixedMsg = new Uint8Array(prefix.length + msgBytes.length)
      prefixedMsg.set(prefix, 0)
      prefixedMsg.set(msgBytes, prefix.length)

      const msgHash = keccak_256(prefixedMsg)
      const signature = secp256k1.sign(msgHash, pkBytes)

      const rHex = signature.r.toString(16).padStart(64, '0')
      const sHex = signature.s.toString(16).padStart(64, '0')
      const v = signature.recovery + 27

      return addHexPrefix(rHex + sHex + v.toString(16).padStart(2, '0'))
    } finally {
      pkBytes.fill(0)
    }
  }
}
