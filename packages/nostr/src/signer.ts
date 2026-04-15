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
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1'
import { bech32 } from '@scure/base'
import type { NostrEventData } from './types.js'

/** Default BIP44 derivation path for Nostr (NIP-06) */
export const NOSTR_HD_PATH = "m/44'/1237'/0'/0/0"

/**
 * Convert a 32-byte public key to npub bech32 encoding.
 */
function pubkeyToNpub(pubkeyHex: string): string {
  const pubkeyBytes = hexToBytes(pubkeyHex)
  return bech32.encodeFromBytes('npub', pubkeyBytes)
}

/**
 * Convert a 32-byte private key to nsec bech32 encoding.
 */
export function privkeyToNsec(privkeyHex: string): string {
  const privkeyBytes = hexToBytes(privkeyHex)
  return bech32.encodeFromBytes('nsec', privkeyBytes)
}

/**
 * Decode an npub or nsec bech32 string to hex.
 */
export function decodeBech32(bech32Str: string): { prefix: string; hex: string } {
  const decoded = bech32.decodeToBytes(bech32Str)
  return { prefix: decoded.prefix, hex: bytesToHex(decoded.bytes) }
}

/**
 * Get the x-only (32-byte) public key from a private key.
 * This is the format used in Nostr (BIP340 / schnorr).
 */
function getXOnlyPubkey(privateKeyBytes: Uint8Array): Uint8Array {
  return schnorr.getPublicKey(privateKeyBytes)
}

/**
 * Compute the event ID (SHA-256 hash of the serialized event).
 * Per NIP-01: SHA256 of the serialized event array:
 * [0, pubkey, created_at, kind, tags, content]
 */
function computeEventId(
  pubkey: string,
  createdAt: number,
  kind: number,
  tags: string[][],
  content: string,
): Uint8Array {
  const serialized = JSON.stringify([0, pubkey, createdAt, kind, tags, content])
  return sha256(new TextEncoder().encode(serialized))
}

/**
 * Nostr signer implementing the ChainSigner interface.
 * Uses secp256k1 schnorr (BIP340) signatures and npub/nsec bech32 encoding.
 */
export class NostrSigner implements ChainSigner {
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
   * Derive a private key from a mnemonic using the Nostr BIP44 path (NIP-06).
   * Returns a hex string (no 0x prefix, as Nostr convention uses raw hex).
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return privateKeyHex
  }

  /**
   * Get the npub (bech32) address for a given private key.
   * The private key can be hex (with or without 0x prefix) or nsec bech32.
   */
  getAddress(privateKey: HexString): Address {
    const pkHex = normalizePrivateKey(privateKey)
    const pkBytes = hexToBytes(pkHex)

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    const xOnlyPubkey = getXOnlyPubkey(pkBytes)
    return pubkeyToNpub(bytesToHex(xOnlyPubkey))
  }

  /**
   * Sign a Nostr event (transaction).
   *
   * The UnsignedTx.extra field must contain NostrEventData:
   * - extra.kind: event kind (number)
   * - extra.content: event content (string)
   * - extra.tags: event tags (string[][])
   *
   * Returns the signed event as a JSON string.
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkHex = normalizePrivateKey(privateKey)
    const pkBytes = hexToBytes(pkHex)

    const eventData = tx.extra as unknown as NostrEventData | undefined
    if (!eventData || typeof eventData.kind !== 'number') {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Nostr transaction requires extra.kind, extra.content, and extra.tags (NostrEventData)',
      )
    }

    const kind = eventData.kind
    const content = eventData.content ?? ''
    const tags = eventData.tags ?? []

    const xOnlyPubkey = getXOnlyPubkey(pkBytes)
    const pubkeyHex = bytesToHex(xOnlyPubkey)
    const createdAt = Math.floor(Date.now() / 1000)

    // Compute event ID
    const eventIdBytes = computeEventId(pubkeyHex, createdAt, kind, tags, content)
    const eventIdHex = bytesToHex(eventIdBytes)

    // Schnorr sign the event ID
    const sig = schnorr.sign(eventIdBytes, pkBytes)
    const sigHex = bytesToHex(sig)

    // Return the signed event as a JSON string
    const signedEvent = {
      id: eventIdHex,
      pubkey: pubkeyHex,
      created_at: createdAt,
      kind,
      tags,
      content,
      sig: sigHex,
    }

    return JSON.stringify(signedEvent)
  }

  /**
   * Sign an arbitrary message using schnorr/BIP340.
   * The message is hashed with SHA-256 before signing.
   * Returns the signature as a hex string.
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
    const pkHex = normalizePrivateKey(privateKey)
    const pkBytes = hexToBytes(pkHex)

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Hash the message with SHA-256
    const msgHash = sha256(msgBytes)

    // Schnorr sign
    const sig = schnorr.sign(msgHash, pkBytes)
    return bytesToHex(sig)
  }
}

/**
 * Normalize a private key input to a raw hex string (no 0x prefix).
 * Accepts: hex with/without 0x prefix, or nsec bech32.
 */
function normalizePrivateKey(privateKey: string): string {
  if (privateKey.startsWith('nsec')) {
    const decoded = decodeBech32(privateKey)
    if (decoded.prefix !== 'nsec') {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Expected nsec prefix, got: ${decoded.prefix}`,
      )
    }
    return decoded.hex
  }
  return privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
}
