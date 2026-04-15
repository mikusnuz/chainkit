import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx } from '@chainkit/core'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

// ed25519 requires sha512 to be set
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
 * Compute CRC16-CCITT for TON user-friendly address encoding.
 */
function crc16(data: Uint8Array): Uint8Array {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff
      } else {
        crc = (crc << 1) & 0xffff
      }
    }
  }
  return new Uint8Array([crc >> 8, crc & 0xff])
}

/**
 * Encode bytes to base64url (no padding).
 */
function toBase64url(data: Uint8Array): string {
  let binary = ''
  for (const byte of data) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_')
}

/**
 * Convert a raw address (workchain:hash) to user-friendly base64url format.
 * Format: [flags(1)][workchain(1)][hash(32)][crc16(2)] = 36 bytes, base64url encoded
 */
function rawToUserFriendly(rawAddress: string, bounceable = true): string {
  const parts = rawAddress.split(':')
  if (parts.length !== 2) {
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Invalid raw address format: ${rawAddress}`)
  }

  const workchain = parseInt(parts[0], 10)
  const hashHex = parts[1]
  const hashBytes = hexToBytes(hashHex.padStart(64, '0'))

  // flags: 0x11 = bounceable, 0x51 = non-bounceable
  const flags = bounceable ? 0x11 : 0x51

  // Build the 34-byte payload
  const payload = new Uint8Array(34)
  payload[0] = flags
  payload[1] = workchain & 0xff
  payload.set(hashBytes, 2)

  // Compute CRC16
  const checksum = crc16(payload)

  // Concatenate payload + checksum
  const result = new Uint8Array(36)
  result.set(payload, 0)
  result.set(checksum, 34)

  return toBase64url(result)
}

/**
 * TON signer implementing the ChainSigner interface.
 * Uses ED25519 for key derivation and signing.
 * Default HD path: m/44'/607'/0'
 */
export class TonSigner implements ChainSigner {
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
   * TON default path: m/44'/607'/0'
   * Returns a '0x'-prefixed hex string (32-byte ED25519 seed).
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return addHexPrefix(privateKeyHex)
  }

  /**
   * Get the TON address for a given private key.
   * Returns the raw address in workchain:hash format (e.g., "0:abc...").
   *
   * The address is computed as:
   * 1. Derive ED25519 public key from private key
   * 2. SHA-256 hash of the public key
   * 3. Format as "0:<hash_hex>"
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

    // SHA-256 hash of the public key to derive address hash
    const hash = sha256(publicKey)

    // TON raw address: workchain(0) + ":" + hash_hex
    return `0:${bytesToHex(hash)}`
  }

  /**
   * Get the user-friendly base64url address for a given private key.
   */
  getUserFriendlyAddress(privateKey: HexString, bounceable = true): string {
    const rawAddress = this.getAddress(privateKey)
    return rawToUserFriendly(rawAddress, bounceable)
  }

  /**
   * Sign a TON transaction (creates a signed BOC message).
   *
   * The transaction fields are serialized as a simple message cell:
   * - to address
   * - amount in nanoton
   * - optional payload
   * - bounce flag
   *
   * The signed result is a hex-encoded string containing the ED25519 signature
   * prepended to the serialized transaction data.
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Serialize transaction data for signing
    const bounce = tx.extra?.bounce !== undefined ? (tx.extra.bounce as boolean) : true
    const payload = tx.data ?? ''

    // Build a deterministic message from transaction fields
    const message = new TextEncoder().encode(
      JSON.stringify({
        to: tx.to,
        value: tx.value,
        bounce,
        payload,
        nonce: tx.nonce ?? 0,
      }),
    )

    // Hash the message
    const messageHash = sha256(message)

    // Sign the hash with ED25519
    const signature = ed25519.sign(messageHash, pkBytes)

    // Return signature (64 bytes) + message as hex
    const signed = new Uint8Array(signature.length + message.length)
    signed.set(signature, 0)
    signed.set(message, signature.length)

    return addHexPrefix(bytesToHex(signed))
  }

  /**
   * Sign an arbitrary message with ED25519.
   * Returns the 64-byte ED25519 signature as a hex string.
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Convert message to bytes
    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Hash and sign with ED25519
    const msgHash = sha256(msgBytes)
    const signature = ed25519.sign(msgHash, pkBytes)

    return addHexPrefix(bytesToHex(signature))
  }

  /**
   * Verify an ED25519 signature.
   */
  verifySignature(
    message: string | Uint8Array,
    signature: HexString,
    publicKey: HexString,
  ): boolean {
    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message
    const msgHash = sha256(msgBytes)
    const sigBytes = hexToBytes(stripHexPrefix(signature))
    const pubBytes = hexToBytes(stripHexPrefix(publicKey))

    return ed25519.verify(sigBytes, msgHash, pubBytes)
  }

  /**
   * Get the public key for a given private key.
   */
  getPublicKey(privateKey: HexString): HexString {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    const publicKey = ed25519.getPublicKey(pkBytes)
    return addHexPrefix(bytesToHex(publicKey))
  }
}

export { rawToUserFriendly }
