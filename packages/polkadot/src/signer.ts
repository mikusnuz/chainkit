import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx } from '@chainkit/core'
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
   * Sign a Polkadot transaction.
   * The transaction data is expected to be serialized in tx.data as a hex string.
   * Returns the ED25519 signature as a hex string.
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    if (!tx.data) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Transaction data (serialized extrinsic payload) is required for Polkadot signing',
      )
    }

    const messageBytes = hexToBytes(stripHexPrefix(tx.data))

    // Sign with ED25519
    const signature = ed25519.sign(messageBytes, pkBytes)

    return addHexPrefix(bytesToHex(signature))
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

export { encodeSS58, decodeSS58 }
