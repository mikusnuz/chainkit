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
import { ripemd160 } from '@noble/hashes/ripemd160'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { base58check } from '@scure/base'

/**
 * Neo3 address version byte.
 */
const NEO3_ADDRESS_VERSION = 0x35

/**
 * Base58check encoder/decoder with SHA-256d checksum.
 */
const b58check = base58check(sha256)

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
 * Derive a P-256 private key from a BIP39 seed and derivation path.
 *
 * Since @scure/bip32 HDKey uses secp256k1, we implement BIP32-like derivation
 * for P-256 manually using HMAC-SHA512. We process the BIP44 path segments
 * and perform hardened derivation for each level.
 */
function deriveP256KeyFromSeed(seed: Uint8Array, path: string): Uint8Array {
  // Parse path segments: "m/44'/888'/0'/0/0" -> [44', 888', 0', 0, 0]
  const segments = path.replace('m/', '').split('/')
  const HARDENED_OFFSET = 0x80000000

  // Master key derivation using HMAC-SHA512 with "Nist256p1 seed" key
  // (same as SLIP-0010 for P-256/secp256r1)
  const masterKey = hmacSha512(
    new TextEncoder().encode('Nist256p1 seed'),
    seed,
  )

  let key: Uint8Array = new Uint8Array(masterKey.slice(0, 32))
  let chainCode: Uint8Array = new Uint8Array(masterKey.slice(32, 64))

  for (const segment of segments) {
    const hardened = segment.endsWith("'")
    const index = parseInt(hardened ? segment.slice(0, -1) : segment, 10)

    if (hardened) {
      // Hardened child: HMAC-SHA512(chainCode, 0x00 || key || ser32(index + 0x80000000))
      const data = new Uint8Array(1 + 32 + 4)
      data[0] = 0x00
      data.set(key, 1)
      const indexVal = (index + HARDENED_OFFSET) >>> 0
      data[33] = (indexVal >>> 24) & 0xff
      data[34] = (indexVal >>> 16) & 0xff
      data[35] = (indexVal >>> 8) & 0xff
      data[36] = indexVal & 0xff

      const derived = hmacSha512(chainCode, data)
      const il = derived.slice(0, 32)

      // key = parse256(IL) + parse256(key) mod n (for secp256r1 order)
      const ilBig = bytesToBigInt(il)
      const keyBig = bytesToBigInt(key)
      const n = p256.CURVE.n
      const newKey = (ilBig + keyBig) % n

      if (ilBig >= n || newKey === 0n) {
        throw new ChainKitError(
          ErrorCode.INVALID_PATH,
          'Derived key is invalid, try a different path',
        )
      }

      key = bigIntToBytes32(newKey)
      chainCode = new Uint8Array(derived.slice(32, 64))
    } else {
      // Normal child: HMAC-SHA512(chainCode, pubkey || ser32(index))
      const pubKey = p256.getPublicKey(key, true) // 33-byte compressed
      const data = new Uint8Array(33 + 4)
      data.set(pubKey, 0)
      const indexVal = index >>> 0
      data[33] = (indexVal >>> 24) & 0xff
      data[34] = (indexVal >>> 16) & 0xff
      data[35] = (indexVal >>> 8) & 0xff
      data[36] = indexVal & 0xff

      const derived = hmacSha512(chainCode, data)
      const il = derived.slice(0, 32)

      const ilBig = bytesToBigInt(il)
      const keyBig = bytesToBigInt(key)
      const n = p256.CURVE.n
      const newKey = (ilBig + keyBig) % n

      if (ilBig >= n || newKey === 0n) {
        throw new ChainKitError(
          ErrorCode.INVALID_PATH,
          'Derived key is invalid, try a different path',
        )
      }

      key = bigIntToBytes32(newKey)
      chainCode = new Uint8Array(derived.slice(32, 64))
    }
  }

  return key
}

/**
 * HMAC-SHA512 helper.
 */
function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha512, key, data)
}

/**
 * Convert bytes to BigInt (big-endian).
 */
function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte)
  }
  return result
}

/**
 * Convert BigInt to 32-byte array (big-endian).
 */
function bigIntToBytes32(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32)
  let v = value
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return bytes
}

/**
 * Build the Neo3 verification script from a compressed public key.
 * Format: 0x0C 0x21 <33-byte compressed pubkey> 0x41 0x56 0xe7 0xb3 0x27
 *
 * 0x0C21 = PUSHDATA1(0x21 = 33) for the public key
 * 0x41 = SYSCALL
 * 0x56e7b327 = InteropHash for System.Crypto.CheckSig
 */
function buildVerificationScript(compressedPubKey: Uint8Array): Uint8Array {
  const script = new Uint8Array(2 + 33 + 1 + 4) // 40 bytes total
  script[0] = 0x0c // PUSHDATA1 opcode
  script[1] = 0x21 // length = 33
  script.set(compressedPubKey, 2)
  script[35] = 0x41 // SYSCALL opcode
  // System.Crypto.CheckSig interop hash (little-endian)
  script[36] = 0x56
  script[37] = 0xe7
  script[38] = 0xb3
  script[39] = 0x27
  return script
}

/**
 * Compute script hash from a verification script.
 * SHA-256 then RIPEMD-160, result is in little-endian.
 */
function getScriptHash(script: Uint8Array): Uint8Array {
  const hash256 = sha256(script)
  return ripemd160(hash256)
}

/**
 * Convert a script hash (little-endian) to a Neo3 address.
 * Format: base58check(version_byte + script_hash)
 */
function scriptHashToAddress(scriptHash: Uint8Array): string {
  const payload = new Uint8Array(1 + scriptHash.length)
  payload[0] = NEO3_ADDRESS_VERSION
  payload.set(scriptHash, 1)
  return b58check.encode(payload)
}

/**
 * Encode a variable-length integer for Neo serialization.
 */
function encodeVarInt(value: number): Uint8Array {
  if (value < 0xfd) {
    return new Uint8Array([value])
  } else if (value <= 0xffff) {
    const buf = new Uint8Array(3)
    buf[0] = 0xfd
    buf[1] = value & 0xff
    buf[2] = (value >> 8) & 0xff
    return buf
  } else if (value <= 0xffffffff) {
    const buf = new Uint8Array(5)
    buf[0] = 0xfe
    buf[1] = value & 0xff
    buf[2] = (value >> 8) & 0xff
    buf[3] = (value >> 16) & 0xff
    buf[4] = (value >> 24) & 0xff
    return buf
  }
  throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'Value too large for varint encoding')
}

/**
 * Encode a variable-length byte array (length-prefixed).
 */
function encodeVarBytes(data: Uint8Array): Uint8Array {
  const lengthPrefix = encodeVarInt(data.length)
  const result = new Uint8Array(lengthPrefix.length + data.length)
  result.set(lengthPrefix, 0)
  result.set(data, lengthPrefix.length)
  return result
}

/**
 * Encode a uint32 in little-endian.
 */
function encodeUint32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  buf[0] = value & 0xff
  buf[1] = (value >> 8) & 0xff
  buf[2] = (value >> 16) & 0xff
  buf[3] = (value >> 24) & 0xff
  return buf
}

/**
 * Encode a uint64 in little-endian from a BigInt.
 */
function encodeUint64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8)
  let v = value
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return buf
}

/**
 * Concatenate multiple Uint8Arrays.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0)
  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/**
 * Reverse a byte array (for converting between big-endian and little-endian).
 */
function reverseBytes(bytes: Uint8Array): Uint8Array {
  const reversed = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    reversed[i] = bytes[bytes.length - 1 - i]
  }
  return reversed
}

/**
 * Neo N3 signer implementing the ChainSigner interface.
 * Uses ECDSA on the P-256 (secp256r1/NIST P-256) curve.
 * Supports BIP39 mnemonic generation and SLIP-0010 key derivation.
 */
export class NeoSigner implements ChainSigner {
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
   * Derive a private key from a mnemonic using SLIP-0010 derivation for P-256.
   * Default path: m/44'/888'/0'/0/0 (Neo coin type = 888).
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKey = deriveP256KeyFromSeed(seed, path)
    return addHexPrefix(bytesToHex(privateKey))
  }

  /**
   * Get the Neo3 address for a given private key.
   * Derives the compressed P-256 public key, builds the verification script,
   * computes the script hash, and encodes as a base58check address.
   */
  getAddress(privateKey: HexString): Address {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get compressed public key (33 bytes: 02/03 + x)
    const compressedPubKey = p256.getPublicKey(pkBytes, true)

    // Build verification script
    const verificationScript = buildVerificationScript(compressedPubKey)

    // Compute script hash (SHA-256 -> RIPEMD-160)
    const scriptHash = getScriptHash(verificationScript)

    // Convert script hash to address
    return scriptHashToAddress(scriptHash)
  }

  /**
   * Sign a Neo N3 transaction.
   *
   * The UnsignedTx is serialized into the Neo3 transaction format:
   * - version (1 byte): 0
   * - nonce (4 bytes LE)
   * - systemFee (8 bytes LE)
   * - networkFee (8 bytes LE)
   * - validUntilBlock (4 bytes LE)
   * - signers (var)
   * - attributes (var)
   * - script (var bytes)
   *
   * The transaction is hashed with SHA-256 twice, then signed with P-256 ECDSA.
   * Returns the signed transaction with witness attached.
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    // Extract Neo-specific fields from the transaction
    const version = 0
    const nonce = tx.nonce ?? 0
    const systemFee = BigInt(tx.fee?.systemFee ?? '0')
    const networkFee = BigInt(tx.fee?.networkFee ?? '0')
    const validUntilBlock = Number(tx.extra?.validUntilBlock ?? 0)
    const script = tx.data ? hexToBytes(stripHexPrefix(tx.data)) : new Uint8Array([])
    const networkMagic = Number(tx.extra?.networkMagic ?? 860833102) // Neo3 mainnet magic

    // Build signer account (script hash of the sender)
    const compressedPubKey = p256.getPublicKey(pkBytes, true)
    const verificationScript = buildVerificationScript(compressedPubKey)
    const senderScriptHash = getScriptHash(verificationScript)

    // Serialize transaction (unsigned portion)
    const txData = concatBytes(
      new Uint8Array([version]),                         // version
      encodeUint32LE(nonce),                             // nonce
      encodeUint64LE(systemFee),                         // systemFee
      encodeUint64LE(networkFee),                        // networkFee
      encodeUint32LE(validUntilBlock),                   // validUntilBlock
      encodeVarInt(1),                                   // signers count = 1
      senderScriptHash,                                  // signer: account (20 bytes)
      new Uint8Array([0x01]),                            // signer: scope = CalledByEntry
      encodeVarInt(0),                                   // attributes count = 0
      encodeVarBytes(script),                            // script
    )

    // Hash the transaction for signing: SHA-256(magic_le_4bytes + SHA-256(txData))
    const magicBytes = encodeUint32LE(networkMagic)
    const txHash = sha256(txData)
    const signingData = concatBytes(magicBytes, txHash)
    const msgHash = sha256(signingData)

    // Sign with P-256
    const signature = p256.sign(msgHash, pkBytes)
    const sigBytes = signature.toCompactRawBytes() // 64 bytes (r + s)

    // Build witness: invocation script + verification script
    // Invocation script: 0x0C 0x40 <64-byte signature>
    const invocationScript = new Uint8Array(2 + 64)
    invocationScript[0] = 0x0c // PUSHDATA1
    invocationScript[1] = 0x40 // length = 64
    invocationScript.set(sigBytes, 2)

    // Serialize signed transaction: txData + witnesses
    const signedTx = concatBytes(
      txData,
      encodeVarInt(1),                                   // witnesses count = 1
      encodeVarBytes(invocationScript),                  // invocation script
      encodeVarBytes(verificationScript),                // verification script
    )

    return addHexPrefix(bytesToHex(signedTx))
  }

  /**
   * Sign an arbitrary message with P-256.
   * Uses SHA-256 hash of the message before signing.
   * Returns the signature as r (32 bytes) + s (32 bytes) = 64 bytes hex.
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    // Convert message to bytes
    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Hash the message with SHA-256
    const msgHash = sha256(msgBytes)

    // Sign with P-256
    const signature = p256.sign(msgHash, pkBytes)
    const sigBytes = signature.toCompactRawBytes() // 64 bytes (r + s)

    return addHexPrefix(bytesToHex(sigBytes))
  }
}
