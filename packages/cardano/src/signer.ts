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
import { bech32 } from '@scure/base'

// @noble/ed25519 v2 requires setting the sha512 hash function
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
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
 * BIP44-style path regex.
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
 * For Cardano CIP-1852: m/1852'/1815'/0'/0/0
 * Note: SLIP-0010 ED25519 requires all path segments to be hardened.
 * Non-hardened segments at the end are treated as hardened internally.
 */
function slip0010DerivePath(seed: Uint8Array, path: string): Uint8Array {
  if (!BIP44_PATH_REGEX.test(path)) {
    throw new ChainKitError(
      ErrorCode.INVALID_PATH,
      `Invalid derivation path: "${path}". Expected format: m/1852'/1815'/0'/0/0`,
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

    // SLIP-0010 ED25519: force hardened derivation for all segments
    const childIndex = index + 0x80000000

    const child = slip0010DeriveChild(key, chainCode, childIndex)
    key = child.key
    chainCode = child.chainCode
  }

  return key
}

/**
 * Generate a Shelley-era bech32 address from an ED25519 public key.
 *
 * Constructs a type-0 (base address with key-key) enterprise-style address:
 * - Header byte: 0x61 (type 6 enterprise address, mainnet)
 * - Payload: 28-byte blake2b-224 hash of the public key
 *
 * Uses enterprise address (type 6) for simplicity (no staking key).
 * Prefix: "addr" for mainnet.
 */
function publicKeyToShelleyAddress(publicKey: Uint8Array): string {
  // blake2b-224 (28 bytes) hash of the public key
  const keyHash = blake2b(publicKey, { dkLen: 28 })

  // Header byte: 0x61 = type 6 (enterprise) + network 1 (mainnet)
  const payload = new Uint8Array(1 + 28)
  payload[0] = 0x61
  payload.set(keyHash, 1)

  // Encode as bech32 with "addr" prefix
  const words = bech32.toWords(payload)
  return bech32.encode('addr', words, 1023)
}

/**
 * Cardano signer implementing the ChainSigner interface.
 * Uses ED25519 keys with SLIP-0010 derivation and bech32 Shelley addresses.
 *
 * Default HD path: m/1852'/1815'/0'/0/0 (CIP-1852)
 */
export class CardanoSigner implements ChainSigner {
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
   * Default path for Cardano: m/1852'/1815'/0'/0/0 (CIP-1852).
   * Returns a '0x'-prefixed hex string of the 32-byte private key.
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKey = slip0010DerivePath(seed, path)
    return addHexPrefix(bytesToHex(privateKey))
  }

  /**
   * Get the Cardano Shelley address (bech32 "addr1...") for a given private key.
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

    return publicKeyToShelleyAddress(publicKey)
  }

  /**
   * Sign a Cardano transaction.
   *
   * The transaction body hash should be provided in tx.data as a hex string.
   * Returns the ED25519 signature as a hex string.
   *
   * In a full Cardano implementation, the transaction body would be CBOR-serialized
   * and then blake2b-256 hashed before signing. Here we sign the hash provided in tx.data.
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
        'Transaction data (CBOR-serialized body hash) is required for Cardano signing',
      )
    }

    const messageBytes = hexToBytes(stripHexPrefix(tx.data))

    // If the data is not already a 32-byte hash, hash it with blake2b-256
    const hashToSign = messageBytes.length === 32
      ? messageBytes
      : blake2b(messageBytes, { dkLen: 32 })

    // Sign with ED25519
    const signature = ed25519.sign(hashToSign, pkBytes)

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
