import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { bech32 } from '@scure/base'

// @noble/ed25519 v2 requires setting the sha512 hash function
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

/** MultiversX bech32 human-readable part */
const BECH32_HRP = 'erd'

/** Default HD derivation path for MultiversX (SLIP-0010 ED25519, all hardened) */
export const MULTIVERSX_DEFAULT_PATH = "m/44'/508'/0'/0'/0'"

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
      `Invalid derivation path: "${path}". Expected format: m/44'/508'/0'/0'/0'`,
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
 * Encode a 32-byte public key as a MultiversX bech32 address with `erd1` prefix.
 */
function pubkeyToBech32(pubkey: Uint8Array): string {
  if (pubkey.length !== 32) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid public key length: expected 32 bytes, got ${pubkey.length}`,
    )
  }
  return bech32.encodeFromBytes(BECH32_HRP, pubkey)
}

/**
 * Decode a MultiversX bech32 address to a 32-byte public key.
 */
function bech32ToPubkey(address: string): Uint8Array {
  const decoded = bech32.decodeToBytes(address)
  if (!address.startsWith(BECH32_HRP + '1')) {
    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      `Invalid address prefix: expected "${BECH32_HRP}1", got "${address.slice(0, 4)}"`,
    )
  }
  if (decoded.bytes.length !== 32) {
    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      `Invalid address: decoded to ${decoded.bytes.length} bytes, expected 32`,
    )
  }
  return decoded.bytes
}

/**
 * MultiversX signer implementing the ChainSigner interface.
 * Uses ED25519 keys with SLIP-0010 derivation and bech32 addresses (erd1 prefix).
 */
export class MultiversXSigner implements ChainSigner {
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
   * Get the MultiversX address (bech32 with `erd1` prefix) for a given private key.
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

    // Encode as bech32 with `erd` human-readable part
    return pubkeyToBech32(publicKey)
  }

  /**
   * Sign a MultiversX transaction.
   * The transaction data is expected to be a JSON-serialized transaction in tx.data as a hex string,
   * or the transaction fields are assembled from the UnsignedTx structure.
   * Returns the ED25519 signature as a hex string.
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Build the transaction object for signing
    // MultiversX signs the JSON-serialized transaction
    let messageBytes: Uint8Array

    if (tx.data) {
      // If tx.data is provided, use it as the serialized transaction message
      messageBytes = hexToBytes(stripHexPrefix(tx.data as string))
    } else {
      // Build a transaction JSON from the UnsignedTx fields
      const txObj: Record<string, unknown> = {
        nonce: tx.nonce ?? 0,
        value: tx.value,
        receiver: tx.to,
        sender: tx.from,
        gasPrice: tx.fee?.gasPrice ? parseInt(tx.fee.gasPrice, 10) : 1000000000,
        gasLimit: tx.fee?.gasLimit ? parseInt(tx.fee.gasLimit, 10) : 50000,
        chainID: (tx.extra?.chainID as string) ?? '1',
        version: (tx.extra?.version as number) ?? 1,
      }

      if (tx.extra?.data) {
        txObj.data = btoa(tx.extra.data as string)
      }

      const jsonStr = JSON.stringify(txObj)
      messageBytes = new TextEncoder().encode(jsonStr)
    }

    // Sign with ED25519
    const signature = ed25519.sign(messageBytes, pkBytes)

    return addHexPrefix(bytesToHex(signature))
  }

  /**
   * Validate a MultiversX bech32 address.
   * MultiversX addresses use bech32 encoding with the 'erd1' prefix
   * and decode to exactly 32 bytes.
   */
  validateAddress(address: string): boolean {
    try {
      if (!address.startsWith('erd1')) return false
      bech32ToPubkey(address)
      return true
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

export { pubkeyToBech32, bech32ToPubkey }
