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
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as secp256k1 from '@noble/secp256k1'

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
 * Compute EIP-55 checksum address from a raw 20-byte hex address.
 * Theta uses the same address format as Ethereum.
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
 * Convert a hex string (possibly with 0x prefix) to minimal bytes for RLP encoding.
 * Strips leading zeros.
 */
function hexToMinimalBytes(hex: string): Uint8Array {
  const stripped = stripHexPrefix(hex)
  if (stripped === '' || stripped === '0') return new Uint8Array([])
  // Remove leading zeros
  let clean = stripped.replace(/^0+/, '')
  if (clean === '') return new Uint8Array([])
  if (clean.length % 2 !== 0) clean = '0' + clean
  return hexToBytes(clean)
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
 * Convert a number to minimal bytes for RLP encoding.
 */
function numberToMinimalBytes(num: number): Uint8Array {
  if (num === 0) return new Uint8Array([])
  let hex = num.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return hexToBytes(hex)
}

/**
 * Theta signer implementing the ChainSigner interface.
 * Uses the same secp256k1 + keccak256 cryptography as Ethereum,
 * but with a different HD derivation path (m/44'/500'/0'/0/0).
 *
 * Supports BIP39/BIP32 key derivation, EIP-191 message signing,
 * and legacy transaction signing (Theta uses EVM-compatible transactions).
 */
export class ThetaSigner implements ChainSigner {
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
   * Default Theta path is m/44'/500'/0'/0/0.
   * Returns a '0x'-prefixed hex string.
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return addHexPrefix(privateKeyHex)
  }

  /**
   * Get the Theta address for a given private key.
   * Returns an EIP-55 checksummed address (same format as Ethereum: 0x + 40 hex).
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
   * Sign a Theta transaction.
   *
   * Theta uses EVM-compatible transaction format. Supports legacy
   * transactions with EIP-155 replay protection.
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    const chainId = (tx.extra?.chainId as number) ?? 361 // Theta mainnet chain ID
    const nonce = tx.nonce ?? 0
    const to = hexToBytes(stripHexPrefix(tx.to))
    const value = tx.value ? decimalToMinimalBytes(tx.value) : new Uint8Array([])
    const data = tx.data ? hexToBytes(stripHexPrefix(tx.data as string)) : new Uint8Array([])

    const gasPrice = tx.fee?.gasPrice
      ? hexToMinimalBytes(tx.fee.gasPrice as string)
      : new Uint8Array([])
    const gasLimit = tx.fee?.gasLimit
      ? hexToMinimalBytes(tx.fee.gasLimit as string)
      : hexToMinimalBytes('0x5208') // 21000 default

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

  /**
   * Validate a Theta address.
   * Theta uses the same address format as Ethereum: 0x + 40 hex characters.
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
   * Sign an arbitrary message using EIP-191 personal_sign.
   * Prepends the standard Ethereum-compatible message prefix.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    // Convert message to bytes
    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // EIP-191 prefix: "\x19Ethereum Signed Message:\n" + message length
    const prefix = new TextEncoder().encode(
      `\x19Ethereum Signed Message:\n${msgBytes.length}`,
    )
    const prefixedMsg = new Uint8Array(prefix.length + msgBytes.length)
    prefixedMsg.set(prefix, 0)
    prefixedMsg.set(msgBytes, prefix.length)

    // Hash the prefixed message
    const msgHash = keccak_256(prefixedMsg)

    // Sign
    const signature = secp256k1.sign(msgHash, pkBytes)

    // Encode as r (32 bytes) + s (32 bytes) + v (1 byte)
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')
    const v = signature.recovery + 27

    return addHexPrefix(rHex + sHex + v.toString(16).padStart(2, '0'))
  }
}
