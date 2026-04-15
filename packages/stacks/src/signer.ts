import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx } from '@chainkit/core'
import {
  getAddressFromPrivateKey,
  makeSTXTokenTransfer,
} from '@stacks/transactions'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as secp256k1 from '@noble/secp256k1'

// @noble/secp256k1 v2 requires manually setting the hmac function
secp256k1.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) => {
  return hmac(sha256, k, secp256k1.etc.concatBytes(...m))
}

/** Default Stacks BIP44 HD path */
export const STACKS_HD_PATH = "m/44'/5757'/0'/0/0"

/** c32 alphabet (Crockford's base32 variant without I, L, O, U) */
const C32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Stacks address version bytes */
const VERSION_MAINNET_SINGLE_SIG = 22
const VERSION_TESTNET_SINGLE_SIG = 26

/**
 * Encode bytes to c32 string using BigInt base conversion.
 */
function c32encode(data: Uint8Array): string {
  if (data.length === 0) return C32_ALPHABET[0]

  // Count leading zero bytes
  let leadingZeros = 0
  for (const byte of data) {
    if (byte === 0) {
      leadingZeros++
    } else {
      break
    }
  }

  // Convert bytes to BigInt
  let num = 0n
  for (const byte of data) {
    num = (num << 8n) | BigInt(byte)
  }

  if (num === 0n) {
    return C32_ALPHABET[0].repeat(leadingZeros || 1)
  }

  // Convert to c32
  const chars: string[] = []
  while (num > 0n) {
    chars.push(C32_ALPHABET[Number(num % 32n)])
    num = num / 32n
  }

  // Prepend leading zeros
  for (let i = 0; i < leadingZeros; i++) {
    chars.push(C32_ALPHABET[0])
  }

  return chars.reverse().join('')
}

/**
 * Compute the c32check checksum (double SHA-256 of version + data, first 4 bytes).
 */
function c32checksum(version: number, data: Uint8Array): Uint8Array {
  const versionedData = new Uint8Array(1 + data.length)
  versionedData[0] = version
  versionedData.set(data, 1)
  const hash1 = sha256(versionedData)
  const hash2 = sha256(hash1)
  return hash2.slice(0, 4)
}

/**
 * Encode data with c32check encoding.
 * Result: version char + c32 encoded (data + checksum)
 */
function c32checkEncode(version: number, data: Uint8Array): string {
  if (version < 0 || version > 31) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid c32check version: ${version}`,
    )
  }

  const checksum = c32checksum(version, data)

  // Concatenate data + checksum
  const dataWithChecksum = new Uint8Array(data.length + checksum.length)
  dataWithChecksum.set(data, 0)
  dataWithChecksum.set(checksum, data.length)

  const versionChar = C32_ALPHABET[version]
  const encoded = c32encode(dataWithChecksum)

  return versionChar + encoded
}

/**
 * Decode a c32check encoded string.
 * Returns { version, data }.
 */
function c32checkDecode(encoded: string): { version: number; data: Uint8Array } {
  if (encoded.length < 2) {
    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      'c32check string too short',
    )
  }

  const versionChar = encoded[0]
  const version = C32_ALPHABET.indexOf(versionChar.toUpperCase())
  if (version < 0) {
    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      `Invalid c32check version character: ${versionChar}`,
    )
  }

  const dataEncoded = encoded.slice(1)
  // hash160 (20 bytes) + checksum (4 bytes) = 24 bytes expected
  const dataWithChecksum = c32decode(dataEncoded, 24)

  if (dataWithChecksum.length < 4) {
    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      'c32check data too short for checksum',
    )
  }

  const data = dataWithChecksum.slice(0, dataWithChecksum.length - 4)
  const checksum = dataWithChecksum.slice(dataWithChecksum.length - 4)

  // Verify checksum
  const expectedChecksum = c32checksum(version, data)
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) {
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        'c32check checksum mismatch',
      )
    }
  }

  return { version, data }
}

/**
 * Normalize c32 string: uppercase, replace ambiguous characters.
 */
function c32normalize(input: string): string {
  return input
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

/**
 * Decode a c32 string to bytes.
 * Uses BigInt for reliable base conversion, with proper length preservation.
 */
function c32decode(encoded: string, expectedBytes?: number): Uint8Array {
  const normalized = c32normalize(encoded)

  if (normalized.length === 0) return new Uint8Array(0)

  // Count leading c32 zeros
  let leadingZeros = 0
  for (const ch of normalized) {
    if (ch === '0') {
      leadingZeros++
    } else {
      break
    }
  }

  // Convert c32 to BigInt
  let num = 0n
  for (const ch of normalized) {
    const idx = C32_ALPHABET.indexOf(ch)
    if (idx < 0) {
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        `Invalid c32 character: ${ch}`,
      )
    }
    num = num * 32n + BigInt(idx)
  }

  // Convert BigInt to bytes
  let hexStr = num === 0n ? '' : num.toString(16)
  if (hexStr.length % 2 !== 0) {
    hexStr = '0' + hexStr
  }
  const numBytes = hexStr.length > 0 ? hexToBytes(hexStr) : new Uint8Array(0)

  // If expectedBytes is provided, pad to that length
  if (expectedBytes && (leadingZeros + numBytes.length) < expectedBytes) {
    const result = new Uint8Array(expectedBytes)
    result.set(numBytes, expectedBytes - numBytes.length)
    return result
  }

  // Prepend leading zero bytes
  const result = new Uint8Array(leadingZeros + numBytes.length)
  result.set(numBytes, leadingZeros)
  return result
}

/**
 * Convert a hash160 (20 bytes) to a Stacks address.
 */
function hash160ToAddress(hash160: Uint8Array, version: number): string {
  // Address format: 'S' + c32checkEncode(version, hash160)
  // c32checkEncode prepends the version char (P for 22, T for 26),
  // so the result is 'S' + 'P' + data = 'SP...' for mainnet
  return 'S' + c32checkEncode(version, hash160)
}

/**
 * Validate a Stacks address.
 */
function isValidStacksAddress(address: string): boolean {
  if (!address.startsWith('SP') && !address.startsWith('ST')) {
    return false
  }

  try {
    // Address format: 'S' + c32checkEncoded
    // The second char is the version char from c32checkEncode
    const encoded = address.slice(1) // Remove 'S' prefix
    const { version, data } = c32checkDecode(encoded)

    const prefix = address.slice(0, 2)
    // Check version matches prefix
    if (prefix === 'SP' && version !== VERSION_MAINNET_SINGLE_SIG) return false
    if (prefix === 'ST' && version !== VERSION_TESTNET_SINGLE_SIG) return false

    // Hash160 should be 20 bytes
    if (data.length !== 20) return false

    return true
  } catch {
    return false
  }
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex
}

function getPrivateKeyBytes(privateKey: HexString): Uint8Array {
  const pkBytes = hexToBytes(stripHexPrefix(privateKey))

  if (pkBytes.length !== 32) {
    throw new ChainKitError(
      ErrorCode.INVALID_PRIVATE_KEY,
      `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
    )
  }

  return pkBytes
}

function getCompressedPrivateKeyHex(privateKey: HexString): string {
  return `${stripHexPrefix(privateKey)}01`
}

/**
 * Stacks signer implementing the ChainSigner interface.
 * Uses secp256k1 with c32check address encoding.
 */
export class StacksSigner implements ChainSigner {
  private readonly network: 'mainnet' | 'testnet'

  constructor(network: 'mainnet' | 'testnet' = 'mainnet') {
    this.network = network
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
   * Derive a private key from a mnemonic using the Stacks BIP44 path.
   * Returns a '0x'-prefixed hex string.
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return '0x' + privateKeyHex
  }

  /**
   * Get the Stacks address for a given private key.
   * Returns an SP... (mainnet) or ST... (testnet) address.
   */
  getAddress(privateKey: HexString): Address {
    getPrivateKeyBytes(privateKey)
    return getAddressFromPrivateKey(
      getCompressedPrivateKeyHex(privateKey),
      this.network,
    )
  }

  /**
   * Sign a Stacks transaction.
   *
   * If tx.data is provided, it is treated as a 32-byte transaction hash and
   * this method returns the recoverable secp256k1 signature. Otherwise it
   * builds and returns a fully serialized signed STX token transfer.
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = getPrivateKeyBytes(privateKey)

    // If tx.data contains a pre-serialized transaction hash, sign it directly
    if (tx.data) {
      const txHash = hexToBytes(stripHexPrefix(tx.data))
      const signature = secp256k1.sign(txHash, pkBytes)

      // Stacks signature format: recovery byte (1) + r (32) + s (32) = 65 bytes
      const rHex = signature.r.toString(16).padStart(64, '0')
      const sHex = signature.s.toString(16).padStart(64, '0')
      const recoveryByte = signature.recovery.toString(16).padStart(2, '0')

      return '0x' + recoveryByte + rHex + sHex
    }

    // Build and sign a standard STX token transfer using the canonical
    // Stacks transaction serializer/signing protocol.
    const network = (tx.extra?.network as 'mainnet' | 'testnet' | undefined) ?? this.network
    const nonce = tx.nonce ?? 0
    const fee = tx.fee?.fee ?? '0'
    const amount = tx.value ?? '0'
    const memo = (tx.extra?.memo as string) ?? ''

    const signedTx = await makeSTXTokenTransfer({
      recipient: tx.to,
      amount: BigInt(amount),
      fee: BigInt(fee),
      nonce: BigInt(nonce),
      memo,
      network,
      senderKey: getCompressedPrivateKeyHex(privateKey),
    })

    return '0x' + signedTx.serialize()
  }

  /**
   * Sign an arbitrary message with the Stacks prefix.
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
    const pkBytes = getPrivateKeyBytes(privateKey)

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Stacks message signing uses the prefix "Stacks Signed Message:\n" + length
    const prefix = new TextEncoder().encode(
      `\x19Stacks Signed Message:\n${msgBytes.length}`,
    )
    const prefixedMsg = new Uint8Array(prefix.length + msgBytes.length)
    prefixedMsg.set(prefix, 0)
    prefixedMsg.set(msgBytes, prefix.length)

    const msgHash = sha256(prefixedMsg)
    const signature = secp256k1.sign(msgHash, pkBytes)

    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')
    const v = signature.recovery + 27

    return '0x' + rHex + sHex + v.toString(16).padStart(2, '0')
  }
}

// Export utilities for testing and external use
export {
  c32checkEncode,
  c32checkDecode,
  c32encode,
  c32decode,
  isValidStacksAddress,
  hash160ToAddress,
  STACKS_HD_PATH as DEFAULT_PATH,
  VERSION_MAINNET_SINGLE_SIG,
  VERSION_TESTNET_SINGLE_SIG,
}
