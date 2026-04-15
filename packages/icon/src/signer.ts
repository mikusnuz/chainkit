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

/** Default ICON BIP44 HD path */
export const ICON_HD_PATH = "m/44'/74'/0'/0/0"

/** Default ICON network ID (mainnet) */
const DEFAULT_NID = '0x1'

/**
 * Strip prefix from a hex string if present.
 */
function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('hx') || hex.startsWith('cx')
    ? hex.slice(2)
    : hex
}

/**
 * Serialize a value for ICON transaction hash computation.
 * ICON uses a custom serialization format (not RLP).
 *
 * Rules:
 * - Strings are used as-is
 * - Objects are serialized as `.key1.value1.key2.value2` (keys sorted)
 * - Arrays are not used in standard transactions
 * - null/undefined are serialized as "\\0"
 */
function serializeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '\\0'
  }
  if (typeof value === 'string') {
    // Escape dots and backslashes
    return value.replace(/\\/g, '\\\\').replace(/\./g, '\\.')
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    let result = ''
    for (const key of keys) {
      result += '.' + key + '.' + serializeValue(obj[key])
    }
    return result
  }
  return String(value)
}

/**
 * Compute the ICON transaction hash.
 * The hash is computed by serializing the transaction parameters
 * in a specific format and then hashing with SHA3-256.
 *
 * Format: "icx_sendTransaction." + sorted key-value pairs
 */
function computeTransactionHash(txParams: Record<string, unknown>): Uint8Array {
  const keys = Object.keys(txParams).sort()
  let serialized = 'icx_sendTransaction'

  for (const key of keys) {
    const val = txParams[key]
    if (val === undefined) continue
    serialized += '.' + key + '.' + serializeValue(val)
  }

  return keccak_256(new TextEncoder().encode(serialized))
}

/**
 * ICON signer implementing the ChainSigner interface.
 * Uses Secp256k1 keys with SHA3-256 (keccak256) for address derivation.
 * Addresses use the `hx` prefix instead of Ethereum's `0x`.
 */
export class IconSigner implements ChainSigner {
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
   * Derive a private key from a mnemonic using BIP44 path.
   * Default path: m/44'/74'/0'/0/0
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return '0x' + privateKeyHex
  }

  /**
   * Get the ICON address for a given private key.
   * Process: uncompressed pubkey -> keccak256 -> last 20 bytes -> hx prefix
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
    return 'hx' + bytesToHex(addressBytes)
  }

  /**
   * Sign an ICON transaction.
   *
   * ICON uses JSON-RPC v3 format. The transaction is serialized, hashed,
   * and signed with secp256k1. The signature is base64-encoded and included
   * in the transaction JSON.
   *
   * Returns the signed transaction as a JSON string (hex-encoded).
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    const nid = (tx.extra?.nid as string) ?? DEFAULT_NID
    const version = '0x3'
    const timestamp = (tx.extra?.timestamp as string) ?? '0x' + (Date.now() * 1000).toString(16)

    // Build transaction parameters
    const txParams: Record<string, unknown> = {
      version,
      from: tx.from,
      to: tx.to,
      nid,
      timestamp,
    }

    // Add value if non-zero
    if (tx.value && tx.value !== '0') {
      const valueLoop = BigInt(tx.value as string)
      txParams.value = '0x' + valueLoop.toString(16)
    }

    // Add step limit (gas equivalent)
    if (tx.fee?.stepLimit) {
      txParams.stepLimit = tx.fee.stepLimit
    } else {
      // Default step limit for ICX transfer: 100000
      txParams.stepLimit = '0x186a0'
    }

    // Add nonce if provided
    if (tx.nonce !== undefined) {
      txParams.nonce = '0x' + tx.nonce.toString(16)
    }

    // Add data for SCORE calls
    if (tx.extra?.dataType) {
      txParams.dataType = tx.extra.dataType as string
      if (tx.extra.data) {
        txParams.data = tx.extra.data
      } else if (tx.data) {
        txParams.data = JSON.parse(tx.data as string)
      }
    }

    // Compute the transaction hash
    const msgHash = computeTransactionHash(txParams)

    // Sign with secp256k1
    const signature = secp256k1.sign(msgHash, pkBytes)

    // Encode signature: r (32 bytes) + s (32 bytes) + recovery (1 byte)
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')
    const vByte = signature.recovery

    const sigBytes = hexToBytes(rHex + sHex)
    const fullSig = new Uint8Array(65)
    fullSig.set(sigBytes, 0)
    fullSig[64] = vByte

    // Base64 encode the signature
    const sigBase64 = btoa(String.fromCharCode(...fullSig))

    // Add signature to transaction params
    txParams.signature = sigBase64

    // Return the signed transaction as a hex-encoded JSON string
    const signedJson = JSON.stringify(txParams)
    const jsonBytes = new TextEncoder().encode(signedJson)
    return '0x' + bytesToHex(jsonBytes)
  }

  /**
   * Validate an ICON address.
   * ICON addresses use 'hx' prefix followed by 40 hex characters.
   */
  validateAddress(address: string): boolean {
    try {
      if (!/^hx[0-9a-fA-F]{40}$/.test(address)) return false
      return true
    } catch {
      return false
    }
  }

  /**
   * Sign an arbitrary message.
   * Hashes the message with keccak256 and signs with secp256k1.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Hash the message with keccak256
    const msgHash = keccak_256(msgBytes)

    // Sign
    const signature = secp256k1.sign(msgHash, pkBytes)

    // Encode as r (32 bytes) + s (32 bytes) + v (1 byte)
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')
    const v = signature.recovery

    return '0x' + rHex + sHex + v.toString(16).padStart(2, '0')
  }
}
