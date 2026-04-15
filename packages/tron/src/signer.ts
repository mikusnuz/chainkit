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
import { sha256 } from '@noble/hashes/sha256'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as secp256k1 from '@noble/secp256k1'
import { base58 } from '@scure/base'

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
 * Compute a double SHA-256 hash (used for base58check checksum).
 */
function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data))
}

/**
 * Encode bytes with base58check encoding (data + 4-byte checksum).
 */
function base58checkEncode(payload: Uint8Array): string {
  const checksum = doubleSha256(payload).slice(0, 4)
  const full = new Uint8Array(payload.length + 4)
  full.set(payload, 0)
  full.set(checksum, payload.length)
  return base58.encode(full)
}

/**
 * Decode a base58check-encoded string and verify the checksum.
 * Returns the payload (without checksum).
 */
function base58checkDecode(encoded: string): Uint8Array {
  const full = base58.decode(encoded)
  if (full.length < 5) {
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, 'Base58check data too short')
  }
  const payload = full.slice(0, full.length - 4)
  const checksum = full.slice(full.length - 4)
  const expectedChecksum = doubleSha256(payload).slice(0, 4)
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) {
      throw new ChainKitError(ErrorCode.INVALID_ADDRESS, 'Invalid base58check checksum')
    }
  }
  return payload
}

/**
 * Convert a Tron base58 address (T...) to a hex address with 41 prefix.
 */
export function addressToHex(address: string): string {
  const payload = base58checkDecode(address)
  return bytesToHex(payload)
}

/**
 * Convert a hex address (41-prefixed, 21 bytes) to Tron base58 address.
 */
export function hexToAddress(hex: string): string {
  const clean = stripHexPrefix(hex)
  const bytes = hexToBytes(clean)
  return base58checkEncode(bytes)
}

/**
 * Tron signer implementing the ChainSigner interface.
 * Supports BIP39/BIP32 key derivation, Tron message signing,
 * and Tron transaction signing using secp256k1.
 *
 * Tron HD Path: m/44'/195'/0'/0/0
 * Address format: Base58check with 0x41 prefix (starts with 'T')
 */
export class TronSigner implements ChainSigner {
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
   * Default Tron path: m/44'/195'/0'/0/0
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return addHexPrefix(privateKeyHex)
  }

  /**
   * Get the Tron address for a given private key.
   * Process: secp256k1 pubkey -> keccak256 -> last 20 bytes -> prepend 0x41 -> base58check
   * Returns a base58 address starting with 'T'.
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

    // Take the last 20 bytes as the raw address
    const addressBytes = hash.slice(-20)

    // Prepend 0x41 byte (Tron mainnet prefix)
    const tronAddressBytes = new Uint8Array(21)
    tronAddressBytes[0] = 0x41
    tronAddressBytes.set(addressBytes, 1)

    // Base58check encode
    return base58checkEncode(tronAddressBytes)
  }

  /**
   * Sign a Tron transaction.
   *
   * Tron transactions use a protobuf-based format. For signing purposes,
   * we expect the raw transaction bytes (txID) in tx.extra.rawDataHex,
   * or we construct a minimal TRX transfer transaction.
   *
   * The signing process: SHA-256 hash of raw tx data -> secp256k1 sign.
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    // If rawDataHex is provided (pre-built transaction from Tron node),
    // use it directly for signing
    const rawDataHex = tx.extra?.rawDataHex as string | undefined
    if (!rawDataHex) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Tron transactions require rawDataHex in tx.extra (obtain from /wallet/createtransaction)',
      )
    }

    // The txID is the SHA-256 hash of the raw_data bytes
    const rawDataBytes = hexToBytes(stripHexPrefix(rawDataHex))
    const txId = sha256(rawDataBytes)

    // Sign the txID with secp256k1
    const signature = secp256k1.sign(txId, pkBytes)

    // Encode as r (32 bytes) + s (32 bytes) + v (1 byte)
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')
    const v = signature.recovery

    return addHexPrefix(rHex + sHex + v.toString(16).padStart(2, '0'))
  }

  /**
   * Sign an arbitrary message using Tron message signing.
   * Prepends the Tron message prefix: "\x19TRON Signed Message:\n" + message length
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    // Convert message to bytes
    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Tron message prefix
    const prefix = new TextEncoder().encode(
      `\x19TRON Signed Message:\n${msgBytes.length}`,
    )
    const prefixedMsg = new Uint8Array(prefix.length + msgBytes.length)
    prefixedMsg.set(prefix, 0)
    prefixedMsg.set(msgBytes, prefix.length)

    // Hash the prefixed message with keccak256
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
