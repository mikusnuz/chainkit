import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx } from '@chainkit/core'
import type { PolkadotTxExtra } from './types.js'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { hmac } from '@noble/hashes/hmac'
import { blake2b } from '@noble/hashes/blake2b'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { base58 } from '@scure/base'

// @noble/ed25519 v2 requires setting the sha512 hash function
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

/**
 * SS58 checksum prefix: literal bytes of "SS58PRE"
 */
const SS58_PREFIX = new TextEncoder().encode('SS58PRE')

/**
 * Network configurations for Polkadot ecosystem chains.
 */
export type PolkadotNetwork = 'polkadot' | 'kusama' | 'substrate'

interface NetworkConfig {
  prefix: number
  symbol: string
  decimals: number
}

const NETWORK_CONFIGS: Record<PolkadotNetwork, NetworkConfig> = {
  polkadot: { prefix: 0, symbol: 'DOT', decimals: 10 },
  kusama: { prefix: 2, symbol: 'KSM', decimals: 12 },
  substrate: { prefix: 42, symbol: 'DOT', decimals: 10 },
}

/**
 * Default HD derivation path for Polkadot (coin type 354).
 * All components are hardened per SLIP-0010 ED25519 requirements.
 */
export const POLKADOT_DEFAULT_PATH = "m/44'/354'/0'/0'/0'"

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

// ========================
// SCALE Codec Primitives
// ========================

/**
 * Concatenate multiple Uint8Arrays into one.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let totalLen = 0
  for (const arr of arrays) totalLen += arr.length
  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/**
 * SCALE compact encoding for unsigned integers.
 *
 * Modes:
 *   - Single-byte: value 0..63 -> (value << 2) | 0b00
 *   - Two-byte:    value 64..16383 -> (value << 2) | 0b01, LE
 *   - Four-byte:   value 16384..2^30-1 -> (value << 2) | 0b10, LE
 *   - Big-integer: value >= 2^30 -> 0b11 | ((byte_length - 4) << 2), then LE bytes
 */
function scaleCompactEncode(value: number | bigint): Uint8Array {
  const v = BigInt(value)
  if (v < 0n) {
    throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'SCALE compact encoding does not support negative values')
  }

  if (v < 64n) {
    // single-byte mode
    return new Uint8Array([Number(v << 2n)])
  }

  if (v < 16384n) {
    // two-byte mode: (value << 2) | 0x01, LE
    const encoded = Number((v << 2n) | 1n)
    return new Uint8Array([encoded & 0xff, (encoded >> 8) & 0xff])
  }

  if (v < 1073741824n) {
    // four-byte mode: (value << 2) | 0x02, LE
    const encoded = Number((v << 2n) | 2n)
    return new Uint8Array([
      encoded & 0xff,
      (encoded >> 8) & 0xff,
      (encoded >> 16) & 0xff,
      (encoded >> 24) & 0xff,
    ])
  }

  // big-integer mode
  // Determine the minimum number of bytes needed to represent the value
  let temp = v
  const bytes: number[] = []
  while (temp > 0n) {
    bytes.push(Number(temp & 0xffn))
    temp >>= 8n
  }
  // Minimum 4 bytes for big-integer mode
  while (bytes.length < 4) bytes.push(0)

  const byteLength = bytes.length
  const header = ((byteLength - 4) << 2) | 0x03
  return new Uint8Array([header, ...bytes])
}

/**
 * Encode a u32 as 4 bytes little-endian.
 */
function scaleEncodeU32LE(v: number): Uint8Array {
  const buf = new Uint8Array(4)
  buf[0] = v & 0xff
  buf[1] = (v >> 8) & 0xff
  buf[2] = (v >> 16) & 0xff
  buf[3] = (v >> 24) & 0xff
  return buf
}

/**
 * Encode a u128 as 16 bytes little-endian.
 */
function scaleEncodeU128LE(v: bigint): Uint8Array {
  const buf = new Uint8Array(16)
  let val = v
  for (let i = 0; i < 16; i++) {
    buf[i] = Number(val & 0xffn)
    val >>= 8n
  }
  return buf
}

/**
 * Encode era bytes.
 * Immortal era = 0x00.
 * Mortal era = 2-byte encoding based on period and current block.
 */
function encodeEra(era?: { period: number; current: number }): Uint8Array {
  if (!era) {
    // Immortal era
    return new Uint8Array([0x00])
  }

  // Mortal era encoding
  // Period must be a power of 2, minimum 4
  let period = era.period
  if (period < 4) period = 4

  // Round up to next power of 2
  let quantizedPeriod = 4
  while (quantizedPeriod < period && quantizedPeriod < 65536) {
    quantizedPeriod *= 2
  }

  const quantizeFactor = Math.max(quantizedPeriod >> 12, 1)
  const phase = (era.current % quantizedPeriod) / quantizeFactor * quantizeFactor

  // calPeriod is log2(quantizedPeriod) - 1, capped at 1..15
  let calPeriod = 0
  let tmp = quantizedPeriod
  while (tmp > 1) {
    calPeriod++
    tmp >>= 1
  }
  calPeriod = Math.max(1, Math.min(15, calPeriod - 1))

  const quantizedPhase = (phase / quantizeFactor) & 0xf

  const first = Math.min(15, calPeriod) | (quantizedPhase << 4)
  const second = (quantizedPhase >> 4) & 0xff

  // 2-byte LE encoding
  return new Uint8Array([first & 0xff, second & 0xff])
}

// ========================
// Polkadot Extrinsic Building
// ========================

/**
 * Build call data for Balances.transferKeepAlive.
 * Format: pallet_index(1 byte) + call_index(1 byte) + MultiAddress(dest) + Compact(amount)
 *
 * MultiAddress::Id = 0x00 + 32-byte AccountId
 */
function buildTransferKeepAliveCallData(
  destPublicKey: Uint8Array,
  amount: bigint,
  palletIndex: number = 5,
  callIndex: number = 3,
): Uint8Array {
  return concatBytes(
    new Uint8Array([palletIndex, callIndex]),    // pallet + call index
    new Uint8Array([0x00]),                       // MultiAddress::Id variant
    destPublicKey,                                // 32-byte AccountId
    scaleCompactEncode(amount),                   // Compact<u128> amount
  )
}

/**
 * Build the signing payload for a Polkadot extrinsic.
 *
 * Payload = callData + era + compact(nonce) + compact(tip) +
 *           specVersion(u32 LE) + transactionVersion(u32 LE) +
 *           genesisHash(32 bytes) + blockHash(32 bytes)
 *
 * If payload length > 256 bytes, sign blake2b-256(payload) instead.
 */
function buildSigningPayload(
  callData: Uint8Array,
  era: Uint8Array,
  nonce: number,
  tip: bigint,
  specVersion: number,
  transactionVersion: number,
  genesisHash: Uint8Array,
  blockHash: Uint8Array,
): Uint8Array {
  const payload = concatBytes(
    callData,
    era,
    scaleCompactEncode(nonce),
    scaleCompactEncode(tip),
    scaleEncodeU32LE(specVersion),
    scaleEncodeU32LE(transactionVersion),
    genesisHash,
    blockHash,
  )

  if (payload.length > 256) {
    return blake2b(payload, { dkLen: 32 })
  }
  return payload
}

/**
 * Assemble a signed extrinsic (SCALE-encoded).
 *
 * Format:
 *   length_prefix (compact) + [
 *     0x84 (signed extrinsic version 4),
 *     MultiAddress::Id (0x00 + 32-byte signer pubkey),
 *     MultiSignature::Ed25519 (0x00 + 64-byte signature),
 *     era,
 *     compact(nonce),
 *     compact(tip),
 *     callData
 *   ]
 */
function assembleSignedExtrinsic(
  signerPublicKey: Uint8Array,
  signature: Uint8Array,
  era: Uint8Array,
  nonce: number,
  tip: bigint,
  callData: Uint8Array,
): Uint8Array {
  const body = concatBytes(
    new Uint8Array([0x84]),                       // signed extrinsic, version 4 (0x80 | 0x04)
    new Uint8Array([0x00]),                       // MultiAddress::Id variant
    signerPublicKey,                              // 32-byte AccountId
    new Uint8Array([0x00]),                       // MultiSignature::Ed25519 variant
    signature,                                    // 64-byte Ed25519 signature
    era,                                          // era encoding
    scaleCompactEncode(nonce),                    // Compact<u64> nonce
    scaleCompactEncode(tip),                      // Compact<u128> tip
    callData,                                     // call bytes
  )

  // Length prefix the entire body
  const lengthPrefix = scaleCompactEncode(body.length)
  return concatBytes(lengthPrefix, body)
}

/**
 * BIP44 path regex for validation.
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
      `Invalid derivation path: "${path}". Expected format: m/44'/354'/0'/0'/0'`,
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

/**
 * Encode a public key as an SS58 address.
 *
 * SS58 format:
 * 1. Prepend network prefix byte to the 32-byte public key
 * 2. Compute checksum: first 2 bytes of blake2b-512(SS58PRE + prefix + pubkey)
 * 3. Base58 encode: prefix + pubkey + checksum[0..2]
 */
function encodeSS58(publicKey: Uint8Array, prefix: number): string {
  // Build the payload: prefix byte + public key
  const payload = new Uint8Array(1 + publicKey.length)
  payload[0] = prefix
  payload.set(publicKey, 1)

  // Compute checksum: blake2b-512(SS58PRE || prefix || pubkey)
  const checksumInput = new Uint8Array(SS58_PREFIX.length + payload.length)
  checksumInput.set(SS58_PREFIX, 0)
  checksumInput.set(payload, SS58_PREFIX.length)
  const hash = blake2b(checksumInput, { dkLen: 64 })

  // Final encoding: prefix + pubkey + first 2 bytes of checksum
  const encoded = new Uint8Array(payload.length + 2)
  encoded.set(payload, 0)
  encoded[payload.length] = hash[0]
  encoded[payload.length + 1] = hash[1]

  return base58.encode(encoded)
}

/**
 * Decode an SS58 address to extract the network prefix and public key.
 * Returns the prefix byte and the 32-byte public key.
 */
function decodeSS58(address: string): { prefix: number; publicKey: Uint8Array } {
  const decoded = base58.decode(address)

  // Minimum: 1 byte prefix + 32 bytes pubkey + 2 bytes checksum = 35 bytes
  if (decoded.length !== 35) {
    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      `Invalid SS58 address length: expected 35 bytes, got ${decoded.length}`,
    )
  }

  const prefix = decoded[0]
  const publicKey = decoded.slice(1, 33)
  const checksumBytes = decoded.slice(33, 35)

  // Verify checksum
  const payload = decoded.slice(0, 33)
  const checksumInput = new Uint8Array(SS58_PREFIX.length + payload.length)
  checksumInput.set(SS58_PREFIX, 0)
  checksumInput.set(payload, SS58_PREFIX.length)
  const hash = blake2b(checksumInput, { dkLen: 64 })

  if (hash[0] !== checksumBytes[0] || hash[1] !== checksumBytes[1]) {
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, 'Invalid SS58 checksum')
  }

  return { prefix, publicKey }
}

/**
 * Polkadot signer implementing the ChainSigner interface.
 * Uses ED25519 keys with SLIP-0010 derivation and SS58 addresses.
 *
 * Note: This uses ED25519 (not SR25519) since SR25519 requires WASM bindings.
 * Both key types are valid on the Polkadot network.
 */
export class PolkadotSigner implements ChainSigner {
  private readonly network: PolkadotNetwork
  private readonly config: NetworkConfig

  constructor(network: PolkadotNetwork = 'polkadot') {
    this.network = network
    this.config = NETWORK_CONFIGS[network]
  }

  /**
   * Get the network configuration.
   */
  getNetworkConfig(): NetworkConfig {
    return { ...this.config }
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
   * Get the SS58-encoded address for a given private key.
   * Uses the configured network prefix for encoding.
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

    // Encode as SS58 with network prefix
    return encodeSS58(publicKey, this.config.prefix)
  }

  /**
   * Sign a Polkadot transaction and return a fully-assembled signed extrinsic.
   *
   * The method builds a Balances.transferKeepAlive extrinsic using SCALE encoding.
   *
   * Required UnsignedTx fields:
   *   - from: sender SS58 address
   *   - to: recipient SS58 address
   *   - value: transfer amount in planck (string)
   *
   * Required UnsignedTx.extra fields (PolkadotTxExtra):
   *   - specVersion: runtime spec version
   *   - transactionVersion: runtime transaction version
   *   - genesisHash: 0x-prefixed 32-byte hex
   *   - blockHash: 0x-prefixed 32-byte hex
   *
   * Optional UnsignedTx.extra fields:
   *   - tip: tip amount in planck (defaults to 0)
   *   - era: { period, current } for mortal era (defaults to immortal)
   *   - palletIndex: Balances pallet index (defaults to 5)
   *   - callIndex: transferKeepAlive call index (defaults to 3)
   *
   * If tx.data is provided (raw pre-encoded call data hex), it is used directly
   * instead of building Balances.transferKeepAlive call data.
   *
   * Returns the 0x-prefixed hex of the complete signed extrinsic, ready for
   * submission via author_submitExtrinsic.
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    const extra = tx.extra as PolkadotTxExtra | undefined

    if (!extra) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Transaction extra fields (specVersion, transactionVersion, genesisHash, blockHash) are required for Polkadot signing. Pass them via tx.extra.',
      )
    }

    if (extra.specVersion === undefined || extra.transactionVersion === undefined) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'specVersion and transactionVersion are required in tx.extra',
      )
    }

    if (!extra.genesisHash || !extra.blockHash) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'genesisHash and blockHash are required in tx.extra',
      )
    }

    // Build call data
    let callData: Uint8Array

    if (tx.data) {
      // Use pre-encoded call data
      callData = hexToBytes(stripHexPrefix(tx.data))
    } else {
      // Build Balances.transferKeepAlive call data
      if (!tx.to) {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'Recipient address (tx.to) is required for balance transfer',
        )
      }

      const { publicKey: destPublicKey } = decodeSS58(tx.to)
      const amount = BigInt(tx.value || '0')
      const palletIndex = extra.palletIndex ?? 5
      const callIndex = extra.callIndex ?? 3

      callData = buildTransferKeepAliveCallData(destPublicKey, amount, palletIndex, callIndex)
    }

    // Encode era
    const era = encodeEra(extra.era)

    // Nonce
    const nonce = tx.nonce ?? 0

    // Tip
    const tip = BigInt(extra.tip ?? 0n)

    // Decode hashes
    const genesisHash = hexToBytes(stripHexPrefix(extra.genesisHash))
    const blockHash = hexToBytes(stripHexPrefix(extra.blockHash))

    if (genesisHash.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        `Invalid genesisHash length: expected 32 bytes, got ${genesisHash.length}`,
      )
    }
    if (blockHash.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        `Invalid blockHash length: expected 32 bytes, got ${blockHash.length}`,
      )
    }

    // Build signing payload
    const signingPayload = buildSigningPayload(
      callData,
      era,
      nonce,
      tip,
      extra.specVersion,
      extra.transactionVersion,
      genesisHash,
      blockHash,
    )

    // Sign with ED25519
    const signature = ed25519.sign(signingPayload, pkBytes)

    // Get signer public key
    const signerPublicKey = ed25519.getPublicKey(pkBytes)

    // Assemble the signed extrinsic
    const signedExtrinsic = assembleSignedExtrinsic(
      signerPublicKey,
      signature,
      era,
      nonce,
      tip,
      callData,
    )

    return addHexPrefix(bytesToHex(signedExtrinsic))
  }

  /**
   * Sign an arbitrary message with ED25519.
   * Returns the 64-byte signature as a hex string.
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

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
  }
}

export {
  encodeSS58,
  decodeSS58,
  scaleCompactEncode,
  scaleEncodeU32LE,
  scaleEncodeU128LE,
  encodeEra,
  buildTransferKeepAliveCallData,
  buildSigningPayload,
  assembleSignedExtrinsic,
  concatBytes,
}
