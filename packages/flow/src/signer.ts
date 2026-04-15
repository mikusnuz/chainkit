import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx } from '@chainkit/core'
import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import { sha512 } from '@noble/hashes/sha512'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

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
 * BIP44 path regex: m / purpose' / coin_type' / account' / change / address_index
 */
const BIP44_PATH_REGEX = /^m(\/\d+'?)+$/

/**
 * HMAC-based key derivation for P-256 from a BIP39 seed.
 *
 * Since @scure/bip32 HDKey is secp256k1-only, we implement a simplified
 * HMAC-based derivation similar to SLIP-0010 but for the P-256 curve.
 *
 * Master key derivation uses "Nist256p1 seed" as the HMAC key per SLIP-0010.
 */
function p256MasterKey(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode('Nist256p1 seed'), seed)
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32),
  }
}

/**
 * SLIP-0010 P-256 child key derivation (hardened only for safety).
 */
function p256DeriveChild(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  const isHardened = index >= 0x80000000

  let data: Uint8Array
  if (isHardened) {
    // Hardened child: HMAC-SHA512(Key = chainCode, Data = 0x00 || parentKey || index)
    data = new Uint8Array(1 + 32 + 4)
    data[0] = 0x00
    data.set(parentKey, 1)
    data[33] = (index >>> 24) & 0xff
    data[34] = (index >>> 16) & 0xff
    data[35] = (index >>> 8) & 0xff
    data[36] = index & 0xff
  } else {
    // Normal child: HMAC-SHA512(Key = chainCode, Data = publicKey || index)
    const publicKey = p256.getPublicKey(parentKey, true)
    data = new Uint8Array(33 + 4)
    data.set(publicKey, 0)
    data[33] = (index >>> 24) & 0xff
    data[34] = (index >>> 16) & 0xff
    data[35] = (index >>> 8) & 0xff
    data[36] = index & 0xff
  }

  const I = hmac(sha512, parentChainCode, data)
  const IL = I.slice(0, 32)
  const IR = I.slice(32)

  // For P-256, the child key = (IL + parentKey) mod n
  const ilBigInt = BigInt('0x' + bytesToHex(IL))
  const parentKeyBigInt = BigInt('0x' + bytesToHex(parentKey))
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551') // P-256 order
  const childKeyBigInt = (ilBigInt + parentKeyBigInt) % n

  if (childKeyBigInt === 0n) {
    // Extremely unlikely; retry with next index
    throw new ChainKitError(
      ErrorCode.INVALID_PATH,
      'Derived key is zero; this is astronomically unlikely.',
    )
  }

  let childKeyHex = childKeyBigInt.toString(16)
  childKeyHex = childKeyHex.padStart(64, '0')
  const childKey = hexToBytes(childKeyHex)

  return {
    key: childKey,
    chainCode: IR,
  }
}

/**
 * Derive a P-256 private key from a seed using SLIP-0010 style derivation.
 */
function p256DerivePath(seed: Uint8Array, path: string): Uint8Array {
  if (!BIP44_PATH_REGEX.test(path)) {
    throw new ChainKitError(
      ErrorCode.INVALID_PATH,
      `Invalid derivation path: "${path}". Expected format: m/44'/539'/0'/0/0`,
    )
  }

  const segments = path.split('/').slice(1) // Remove "m"
  let { key, chainCode } = p256MasterKey(seed)

  for (const segment of segments) {
    const hardened = segment.endsWith("'")
    const indexStr = hardened ? segment.slice(0, -1) : segment
    const index = parseInt(indexStr, 10)

    if (isNaN(index)) {
      throw new ChainKitError(ErrorCode.INVALID_PATH, `Invalid path segment: ${segment}`)
    }

    const childIndex = hardened ? index + 0x80000000 : index
    const child = p256DeriveChild(key, chainCode, childIndex)
    key = child.key
    chainCode = child.chainCode
  }

  return key
}

/**
 * Encode r and s values into DER format for signature verification.
 */
function encodeDerSignature(rBytes: Uint8Array, sBytes: Uint8Array): Uint8Array {
  // Strip leading zeros and add 0x00 prefix if high bit is set
  const encodeInt = (bytes: Uint8Array): Uint8Array => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    const trimmed = bytes.slice(start)
    if (trimmed[0] & 0x80) {
      const padded = new Uint8Array(trimmed.length + 1)
      padded[0] = 0x00
      padded.set(trimmed, 1)
      return padded
    }
    return trimmed
  }

  const rDer = encodeInt(rBytes)
  const sDer = encodeInt(sBytes)

  // DER: 0x30 [total-len] 0x02 [r-len] [r] 0x02 [s-len] [s]
  const totalLen = 2 + rDer.length + 2 + sDer.length
  const der = new Uint8Array(2 + totalLen)
  der[0] = 0x30
  der[1] = totalLen
  der[2] = 0x02
  der[3] = rDer.length
  der.set(rDer, 4)
  der[4 + rDer.length] = 0x02
  der[5 + rDer.length] = sDer.length
  der.set(sDer, 6 + rDer.length)

  return der
}

/**
 * Flow signer implementing the ChainSigner interface.
 * Uses ECDSA P-256 (secp256r1, NIST P-256) for key generation and signing.
 *
 * HD Path: m/44'/539'/0'/0/0 (BIP44 coin type 539 for Flow)
 * Address: Flow addresses are assigned by the network (8 bytes, 16 hex chars).
 *          getAddress() returns a SHA-256 hash of the public key as a deterministic identifier.
 *
 * Crypto: ECDSA_P256 via @noble/curves/p256
 */
export class FlowSigner implements ChainSigner {
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
   * Derive a P-256 private key from a mnemonic using SLIP-0010 style derivation.
   * Returns a '0x'-prefixed hex string of the 32-byte private key.
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKey = p256DerivePath(seed, path)
    return addHexPrefix(bytesToHex(privateKey))
  }

  /**
   * Get a deterministic address identifier for a given private key.
   *
   * Flow addresses are NOT derived from public keys - they are assigned by the
   * network when an account is created. This method returns a SHA-256 hash of
   * the uncompressed public key, formatted as 0x + 16 hex chars (8 bytes),
   * to serve as a deterministic placeholder identifier.
   *
   * The actual on-chain Flow address must be obtained by creating an account
   * on the Flow network.
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
    const publicKey = p256.getPublicKey(pkBytes, false)

    // SHA-256 hash of the public key
    const hash = sha256(publicKey)

    // Take last 8 bytes (16 hex chars) to match Flow address format
    const addressBytes = hash.slice(-8)
    return '0x' + bytesToHex(addressBytes)
  }

  /**
   * Get the uncompressed public key (without 04 prefix) for a given private key.
   * This is used for Flow account key registration.
   */
  getPublicKey(privateKey: HexString): HexString {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get uncompressed public key and strip the 04 prefix
    const publicKey = p256.getPublicKey(pkBytes, false)
    return addHexPrefix(bytesToHex(publicKey.slice(1)))
  }

  /**
   * Sign a Flow transaction.
   *
   * The transaction envelope to sign should be provided in tx.data as a hex string.
   * This is the RLP-encoded transaction payload that Flow requires.
   * Returns the ECDSA P-256 signature as a hex string (r || s, each 32 bytes).
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
        'Transaction data (encoded transaction payload) is required for Flow signing',
      )
    }

    const messageBytes = hexToBytes(stripHexPrefix(tx.data))

    // Flow signs the SHA-256 hash of the transaction payload
    const msgHash = sha256(messageBytes)

    // Sign with P-256
    const signature = p256.sign(msgHash, pkBytes)

    // Encode as r (32 bytes) + s (32 bytes) - no recovery byte
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')

    return addHexPrefix(rHex + sHex)
  }

  /**
   * Sign an arbitrary message with ECDSA P-256.
   * The message is SHA-256 hashed before signing.
   * Returns the signature as r (32 bytes) + s (32 bytes) hex string.
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

    // SHA-256 hash for signing
    const msgHash = sha256(msgBytes)

    // Sign with P-256
    const signature = p256.sign(msgHash, pkBytes)

    // Encode as r (32 bytes) + s (32 bytes)
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')

    return addHexPrefix(rHex + sHex)
  }

  /**
   * Verify an ECDSA P-256 signature.
   * @param message - The original message (will be SHA-256 hashed)
   * @param signature - The signature as hex (r || s, each 32 bytes)
   * @param publicKey - The uncompressed public key (without 04 prefix) as hex
   */
  verifySignature(
    message: string | Uint8Array,
    signature: HexString,
    publicKey: HexString,
  ): boolean {
    const sigBytes = hexToBytes(stripHexPrefix(signature))
    if (sigBytes.length !== 64) return false

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message
    const msgHash = sha256(msgBytes)

    // Reconstruct full uncompressed public key with 04 prefix
    const pubKeyHex = stripHexPrefix(publicKey)
    const fullPubKey = hexToBytes('04' + pubKeyHex)

    try {
      // p256.verify expects a DER-encoded signature or compact signature
      // Convert r||s (64 bytes) to DER format
      const rBytes = sigBytes.slice(0, 32)
      const sBytes = sigBytes.slice(32)

      const derSig = encodeDerSignature(rBytes, sBytes)
      return p256.verify(derSig, msgHash, fullPubKey)
    } catch {
      return false
    }
  }
}
