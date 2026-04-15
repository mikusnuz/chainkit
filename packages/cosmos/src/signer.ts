import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx } from '@chainkit/core'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as secp256k1 from '@noble/secp256k1'
import { bech32 } from '@scure/base'

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
 * Cosmos signer implementing the ChainSigner interface.
 * Supports BIP39/BIP32 key derivation, secp256k1 signing,
 * and bech32 address generation with the "cosmos" prefix.
 */
export class CosmosSigner implements ChainSigner {
  private readonly prefix: string

  constructor(prefix: string = 'cosmos') {
    this.prefix = prefix
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
   * Derive a private key from a mnemonic using a BIP44 HD path.
   * Returns a '0x'-prefixed hex string.
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return addHexPrefix(privateKeyHex)
  }

  /**
   * Get the Cosmos address for a given private key.
   * Derives the compressed secp256k1 public key, then:
   *   SHA-256 -> RIPEMD-160 -> bech32 encode with prefix.
   */
  getAddress(privateKey: HexString): Address {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get the compressed public key (33 bytes)
    const publicKey = secp256k1.getPublicKey(pkBytes, true)

    // SHA-256 hash of the public key
    const shaHash = sha256(publicKey)

    // RIPEMD-160 hash of the SHA-256 hash
    const ripeHash = ripemd160(shaHash)

    // Bech32 encode with cosmos prefix
    const words = bech32.toWords(ripeHash)
    return bech32.encode(this.prefix, words)
  }

  /**
   * Sign a Cosmos transaction.
   * The transaction data should be serialized into the UnsignedTx format.
   * Returns the signature as a hex string.
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    // For Cosmos, the sign doc is typically provided as JSON in tx.data
    // or constructed from the extra fields
    const signDoc = tx.data ?? tx.extra?.signDoc as string ?? ''

    // Convert sign doc to bytes
    const msgBytes = typeof signDoc === 'string'
      ? new TextEncoder().encode(signDoc)
      : hexToBytes(stripHexPrefix(signDoc as string))

    // Hash the sign doc with SHA-256
    const msgHash = sha256(msgBytes)

    // Sign
    const signature = secp256k1.sign(msgHash, pkBytes)

    // Return r (32 bytes) + s (32 bytes) = 64 bytes
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')

    return addHexPrefix(rHex + sHex)
  }

  /**
   * Sign an arbitrary message.
   * Uses the Cosmos ADR-036 style: SHA-256 hash of the message bytes.
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    // Convert message to bytes
    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // SHA-256 hash of the message
    const msgHash = sha256(msgBytes)

    // Sign
    const signature = secp256k1.sign(msgHash, pkBytes)

    // Return r (32 bytes) + s (32 bytes) = 64 bytes
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')

    return addHexPrefix(rHex + sHex)
  }
}
