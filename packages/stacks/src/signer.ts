import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import { sha256 } from '@noble/hashes/sha256'
import { sha512_256 } from '@noble/hashes/sha512'
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

// ---------------------------------------------------------------------------
// Native SIP-005 STX token transfer serialization
// ---------------------------------------------------------------------------

/** Write a u64 big-endian into buf at the given offset. */
function writeU64BE(buf: Uint8Array, offset: number, value: bigint): void {
  const hi = Number((value >> 32n) & 0xffffffffn)
  const lo = Number(value & 0xffffffffn)
  buf[offset] = (hi >>> 24) & 0xff
  buf[offset + 1] = (hi >>> 16) & 0xff
  buf[offset + 2] = (hi >>> 8) & 0xff
  buf[offset + 3] = hi & 0xff
  buf[offset + 4] = (lo >>> 24) & 0xff
  buf[offset + 5] = (lo >>> 16) & 0xff
  buf[offset + 6] = (lo >>> 8) & 0xff
  buf[offset + 7] = lo & 0xff
}

/** Write a u32 big-endian into buf at the given offset. */
function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff
  buf[offset + 1] = (value >>> 16) & 0xff
  buf[offset + 2] = (value >>> 8) & 0xff
  buf[offset + 3] = value & 0xff
}

interface StxTransferParams {
  recipient: string
  amount: bigint
  fee: bigint
  nonce: bigint
  memo: string
  network: 'mainnet' | 'testnet'
  privateKey: Uint8Array
}

/**
 * Serialize a STX token transfer transaction following SIP-005 and sign it
 * using the two-stage sighash process with sha512/256.
 *
 * Returns the hex string of the fully signed serialized transaction.
 */
function serializeAndSignStxTransfer(params: StxTransferParams): string {
  const { recipient, amount, fee, nonce, memo, network, privateKey } = params

  // Decode recipient address: strip 'S' prefix, then c32check decode
  const recipientEncoded = recipient.slice(1) // remove 'S'
  const { version: recipientVersion, data: recipientHash160 } =
    c32checkDecode(recipientEncoded)

  // Derive sender's compressed pubkey hash160
  const pubkey = secp256k1.getPublicKey(privateKey, true)
  const senderHash160 = ripemd160(sha256(pubkey))

  // SIP-005 TokenTransfer memo: 34 bytes total, raw content zero-padded.
  const memoBytes = new Uint8Array(34)
  if (memo.length > 0) {
    const encoded = new TextEncoder().encode(memo)
    const copyLen = Math.min(encoded.length, 34)
    memoBytes.set(encoded.subarray(0, copyLen), 0)
  }

  // --- Compute transaction byte sizes ---
  // Header: version(1) + chain_id(4) = 5
  // Authorization (P2PKH SingleSig):
  //   type_id(1) + hash_mode(1) + signer(20) + nonce(8) + fee(8)
  //   + key_encoding(1) + signature(65) = 104
  // Anchor mode: 1
  // Post-condition mode: 1
  // Post-conditions length: 4 (u32, value 0)
  // Payload type: 1
  // Recipient principal: type(1) + version(1) + hash160(20) = 22
  // Amount: 8
  // Memo: 34
  // Total = 5 + 104 + 1 + 1 + 4 + 1 + 22 + 8 + 34 = 180
  const TX_SIZE = 180

  function buildTx(signature: Uint8Array, txNonce: bigint, txFee: bigint): Uint8Array {
    const buf = new Uint8Array(TX_SIZE)
    let offset = 0

    // Version byte
    buf[offset++] = network === 'mainnet' ? 0x00 : 0x80

    // Chain ID (u32 BE)
    writeU32BE(buf, offset, network === 'mainnet' ? 0x00000001 : 0x80000000)
    offset += 4

    // --- Authorization (Standard spending condition, single-sig P2PKH) ---
    // auth_type: 0x04 = Standard
    buf[offset++] = 0x04
    // hash_mode: 0x00 = P2PKH
    buf[offset++] = 0x00
    // signer: 20-byte hash160 of compressed pubkey
    buf.set(senderHash160, offset)
    offset += 20
    // nonce: u64 BE
    writeU64BE(buf, offset, txNonce)
    offset += 8
    // fee: u64 BE
    writeU64BE(buf, offset, txFee)
    offset += 8
    // key_encoding: 0x00 = compressed (Stacks PubKeyEncoding.Compressed = 0)
    buf[offset++] = 0x00
    // signature: 65 bytes (recovery_id byte + r 32 bytes + s 32 bytes)
    buf.set(signature, offset)
    offset += 65

    // Anchor mode: 0x03 = Any
    buf[offset++] = 0x03

    // Post-condition mode: 0x02 = Allow
    buf[offset++] = 0x02

    // Post-conditions length: u32 BE = 0
    writeU32BE(buf, offset, 0)
    offset += 4

    // --- Payload (Token Transfer) ---
    // payload_type: 0x00 = token transfer
    buf[offset++] = 0x00

    // Recipient: standard principal
    // type_id: 0x05 = standard principal
    buf[offset++] = 0x05
    // version byte from c32check decode
    buf[offset++] = recipientVersion
    // hash160: 20 bytes
    buf.set(recipientHash160, offset)
    offset += 20

    // Amount: u64 BE
    writeU64BE(buf, offset, amount)
    offset += 8

    // Memo: 34 bytes
    buf.set(memoBytes, offset)
    offset += 34

    return buf
  }

  // Step 1: Build the "initial sighash" transaction with cleared spending condition
  // Per SIP-005, the initial sighash uses nonce=0, fee=0, and empty signature
  // (the actual nonce/fee are included only in the presign sighash step)
  const emptySig = new Uint8Array(65)
  const initialTx = buildTx(emptySig, 0n, 0n)

  // Step 2: Initial sighash = sha512/256(serialized_tx_with_cleared_condition)
  const initialSighash = sha512_256(initialTx)

  // Step 3: Presign sighash
  //   presign_input = initialSighash(32) + auth_flag(1) + fee(8) + nonce(8) = 49 bytes
  const presignInput = new Uint8Array(49)
  presignInput.set(initialSighash, 0)
  presignInput[32] = 0x04 // auth_flag = Standard
  writeU64BE(presignInput, 33, fee)
  writeU64BE(presignInput, 41, nonce)
  const finalHash = sha512_256(presignInput)

  // Step 4: Sign with secp256k1
  const sig = secp256k1.sign(finalHash, privateKey)

  // Step 5: Build the 65-byte signature (recovery_id + r + s)
  const sigBytes = new Uint8Array(65)
  sigBytes[0] = sig.recovery
  const rHex = sig.r.toString(16).padStart(64, '0')
  const sHex = sig.s.toString(16).padStart(64, '0')
  sigBytes.set(hexToBytes(rHex), 1)
  sigBytes.set(hexToBytes(sHex), 33)

  // Step 6: Build final transaction with real signature and actual nonce/fee
  const finalTx = buildTx(sigBytes, nonce, fee)
  return bytesToHex(finalTx)
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
   *
   * Derivation: secp256k1 compressed pubkey -> SHA-256 -> RIPEMD-160 -> c32check
   */
  getAddress(privateKey: HexString): Address {
    const pkBytes = getPrivateKeyBytes(privateKey)
    const pubkey = secp256k1.getPublicKey(pkBytes, true) // compressed
    const hash = ripemd160(sha256(pubkey))
    const version =
      this.network === 'mainnet'
        ? VERSION_MAINNET_SINGLE_SIG
        : VERSION_TESTNET_SINGLE_SIG
    return hash160ToAddress(hash, version)
  }

  /**
   * Sign a Stacks transaction.
   *
   * If tx.data is provided, it is treated as a 32-byte transaction hash and
   * this method returns the recoverable secp256k1 signature. Otherwise it
   * builds and returns a fully serialized signed STX token transfer.
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
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

    // Build and sign a standard STX token transfer natively (SIP-005).
    const network = (tx.extra?.network as 'mainnet' | 'testnet' | undefined) ?? this.network
    const nonce = BigInt(tx.nonce ?? 0)
    const fee = BigInt(tx.fee?.fee ?? '0')
    const amount = BigInt(tx.value ?? '0')
    const memo = (tx.extra?.memo as string) ?? ''

    const serializedHex = serializeAndSignStxTransfer({
      recipient: tx.to,
      amount,
      fee,
      nonce,
      memo,
      network,
      privateKey: pkBytes,
    })

    return '0x' + serializedHex
  }

  /**
   * Sign an arbitrary message with the Stacks prefix.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
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
