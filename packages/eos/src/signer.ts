import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as secp256k1 from '@noble/secp256k1'
import { base58 } from '@scure/base'

// @noble/secp256k1 v2 requires manually setting the hmac function
secp256k1.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) => {
  return hmac(sha256, k, secp256k1.etc.concatBytes(...m))
}

/** Default BIP44 HD path for EOS: m/44'/194'/0'/0/0 */
export const EOS_HD_PATH = "m/44'/194'/0'/0/0"

/**
 * Convert a compressed public key (33 bytes) to EOS public key format.
 * Format: "EOS" + base58(compressed_pubkey + ripemd160_checksum)
 *
 * The checksum is the first 4 bytes of RIPEMD160(compressed_pubkey).
 */
export function publicKeyToEosFormat(compressedPubKey: Uint8Array): string {
  if (compressedPubKey.length !== 33) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Expected 33-byte compressed public key, got ${compressedPubKey.length} bytes`,
    )
  }

  const checksum = ripemd160(compressedPubKey).slice(0, 4)
  const payload = new Uint8Array(compressedPubKey.length + 4)
  payload.set(compressedPubKey, 0)
  payload.set(checksum, compressedPubKey.length)

  return 'EOS' + base58.encode(payload)
}

/**
 * Decode an EOS public key string back to compressed public key bytes.
 * Validates the RIPEMD160 checksum.
 */
export function eosFormatToPublicKey(eosKey: string): Uint8Array {
  if (!eosKey.startsWith('EOS')) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `EOS public key must start with "EOS", got "${eosKey.substring(0, 10)}"`,
    )
  }

  const decoded = base58.decode(eosKey.slice(3))
  if (decoded.length !== 37) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid EOS public key length: expected 37 bytes after decode, got ${decoded.length}`,
    )
  }

  const pubKey = decoded.slice(0, 33)
  const checksum = decoded.slice(33, 37)
  const computedChecksum = ripemd160(pubKey).slice(0, 4)

  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== computedChecksum[i]) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'EOS public key checksum mismatch',
      )
    }
  }

  return pubKey
}

/**
 * Encode an EOS signature in the SIG_K1_ format.
 * Format: "SIG_K1_" + base58(signature_bytes + ripemd160("K1" + signature_bytes) checksum)
 *
 * signature_bytes = compact_signature (64 bytes) + recovery (1 byte) = 65 bytes
 */
function encodeEosSignature(compactSig: Uint8Array, recovery: number): string {
  // Build 65-byte canonical signature: recovery + r + s
  const sigBytes = new Uint8Array(65)
  sigBytes[0] = recovery + 27 + 4 // compressed key marker
  sigBytes.set(compactSig.slice(0, 32), 1) // r
  sigBytes.set(compactSig.slice(32, 64), 33) // s

  // Checksum: ripemd160(sigBytes + "K1"), first 4 bytes
  // EOSIO fc convention: data first, then type suffix
  const checksumData = new Uint8Array(65 + 2)
  checksumData.set(sigBytes, 0)
  checksumData[65] = 0x4b // 'K'
  checksumData[66] = 0x31 // '1'
  const checksum = ripemd160(checksumData).slice(0, 4)

  const payload = new Uint8Array(65 + 4)
  payload.set(sigBytes, 0)
  payload.set(checksum, 65)

  return 'SIG_K1_' + base58.encode(payload)
}

/**
 * Serialize an unsigned EOS transaction to binary for signing.
 * This is a simplified serialization for basic transfer actions.
 *
 * EOSIO packed transaction format:
 * - expiration (uint32)
 * - ref_block_num (uint16)
 * - ref_block_prefix (uint32)
 * - max_net_usage_words (varuint32)
 * - max_cpu_usage_ms (uint8)
 * - delay_sec (varuint32)
 * - context_free_actions (varuint32 length + data)
 * - actions (varuint32 length + serialized actions)
 * - transaction_extensions (varuint32 length)
 */
function serializeTransaction(
  tx: UnsignedTx,
  chainId: string,
): Uint8Array {
  const expiration = tx.extra?.expiration as number ?? Math.floor(Date.now() / 1000) + 60
  const refBlockNum = tx.extra?.refBlockNum as number ?? 0
  const refBlockPrefix = tx.extra?.refBlockPrefix as number ?? 0
  const maxNetUsageWords = tx.extra?.maxNetUsageWords as number ?? 0
  const maxCpuUsageMs = tx.extra?.maxCpuUsageMs as number ?? 0
  const delaySec = tx.extra?.delaySec as number ?? 0

  // Serialize the action data (hex-encoded in tx.data)
  const txData = tx.data as string | undefined; const actionData = txData ? hexToBytes(txData.startsWith("0x") ? txData.slice(2) : txData) : new Uint8Array(0)

  const account = tx.extra?.account as string ?? 'eosio.token'
  const actionName = tx.extra?.actionName as string ?? 'transfer'
  const actor = tx.from as string
  const permission = tx.extra?.permission as string ?? 'active'

  // Encode account names as uint64
  const accountEncoded = nameToUint64Bytes(account)
  const actionNameEncoded = nameToUint64Bytes(actionName)
  const actorEncoded = nameToUint64Bytes(actor)
  const permissionEncoded = nameToUint64Bytes(permission)

  // Build the transaction body
  const parts: Uint8Array[] = []

  // expiration (uint32 LE)
  parts.push(uint32LE(expiration))
  // ref_block_num (uint16 LE)
  parts.push(uint16LE(refBlockNum & 0xffff))
  // ref_block_prefix (uint32 LE)
  parts.push(uint32LE(refBlockPrefix))
  // max_net_usage_words (varuint32)
  parts.push(encodeVaruint32(maxNetUsageWords))
  // max_cpu_usage_ms (uint8)
  parts.push(new Uint8Array([maxCpuUsageMs]))
  // delay_sec (varuint32)
  parts.push(encodeVaruint32(delaySec))
  // context_free_actions (empty list)
  parts.push(encodeVaruint32(0))

  // actions (1 action)
  parts.push(encodeVaruint32(1))
  // action: account (uint64)
  parts.push(accountEncoded)
  // action: name (uint64)
  parts.push(actionNameEncoded)
  // action: authorization (1 auth)
  parts.push(encodeVaruint32(1))
  parts.push(actorEncoded)
  parts.push(permissionEncoded)
  // action: data (varuint32 length + bytes)
  parts.push(encodeVaruint32(actionData.length))
  parts.push(actionData)

  // transaction_extensions (empty)
  parts.push(encodeVaruint32(0))

  // Concatenate all parts
  const totalLen = parts.reduce((s, p) => s + p.length, 0)
  const txBody = new Uint8Array(totalLen)
  let offset = 0
  for (const p of parts) {
    txBody.set(p, offset)
    offset += p.length
  }

  // Signing digest: sha256(chainId + serialized_transaction + context_free_data_hash)
  // context_free_data_hash = sha256 of empty (32 zero bytes)
  const chainIdBytes = hexToBytes(chainId)
  const contextFreeHash = new Uint8Array(32) // sha256 of no context-free data = zeros

  const signingData = new Uint8Array(chainIdBytes.length + txBody.length + 32)
  signingData.set(chainIdBytes, 0)
  signingData.set(txBody, chainIdBytes.length)
  signingData.set(contextFreeHash, chainIdBytes.length + txBody.length)

  return signingData
}

/**
 * Encode an EOSIO name (up to 12 characters) as a uint64 in little-endian bytes.
 * EOSIO names use a custom base-32 encoding: .12345abcdefghijklmnopqrstuvwxyz
 */
export function nameToUint64Bytes(name: string): Uint8Array {
  const charMap = '.12345abcdefghijklmnopqrstuvwxyz'
  let value = 0n

  const len = Math.min(name.length, 12)
  for (let i = 0; i < len; i++) {
    const c = charMap.indexOf(name[i])
    if (c < 0) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        `Invalid character '${name[i]}' in EOSIO name "${name}"`,
      )
    }
    // First 12 chars are 5-bit each, starting from the high bits
    value |= BigInt(c & 0x1f) << BigInt(64 - 5 * (i + 1))
  }

  // 13th character (if present) is only 4 bits
  if (name.length > 12) {
    const c = charMap.indexOf(name[12])
    if (c < 0) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        `Invalid character '${name[12]}' in EOSIO name "${name}"`,
      )
    }
    value |= BigInt(c & 0x0f)
  }

  // Convert to 8-byte little-endian
  const bytes = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn)
  }
  return bytes
}

/**
 * Convert uint64 little-endian bytes back to an EOSIO name string.
 */
export function uint64BytesToName(bytes: Uint8Array): string {
  const charMap = '.12345abcdefghijklmnopqrstuvwxyz'
  let value = 0n
  for (let i = 0; i < 8; i++) {
    value |= BigInt(bytes[i]) << BigInt(i * 8)
  }

  let name = ''
  for (let i = 0; i < 13; i++) {
    if (i < 12) {
      const c = Number((value >> BigInt(64 - 5 * (i + 1))) & 0x1fn)
      name += charMap[c]
    } else {
      const c = Number(value & 0x0fn)
      name += charMap[c]
    }
  }

  // Trim trailing dots
  return name.replace(/\.+$/, '')
}

function uint32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  buf[0] = value & 0xff
  buf[1] = (value >>> 8) & 0xff
  buf[2] = (value >>> 16) & 0xff
  buf[3] = (value >>> 24) & 0xff
  return buf
}

function uint16LE(value: number): Uint8Array {
  const buf = new Uint8Array(2)
  buf[0] = value & 0xff
  buf[1] = (value >>> 8) & 0xff
  return buf
}

function encodeVaruint32(value: number): Uint8Array {
  const bytes: number[] = []
  let v = value
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v > 0) b |= 0x80
    bytes.push(b)
  } while (v > 0)
  return new Uint8Array(bytes)
}

/**
 * EOS signer implementing the ChainSigner interface.
 * Uses secp256k1 (K1) curve, EOS public key format, and EOSIO transaction serialization.
 */
export class EosSigner implements ChainSigner {
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
   * Derive a private key from a mnemonic using the EOS BIP44 HD path.
   * Returns a hex string (without 0x prefix by convention, but consistent with core).
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return privateKeyHex
  }

  /**
   * Get the EOS public key (address) for a given private key.
   * Returns an EOS-format public key string (e.g., "EOS6MRy...").
   *
   * Note: In EOS, "addresses" are named accounts (e.g., "myaccount123"),
   * which are separate from public keys. This method returns the public key
   * that would be associated with an account.
   */
  getAddress(privateKey: HexString): Address {
    const pkHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
    const pkBytes = hexToBytes(pkHex)

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get compressed public key (33 bytes)
    const publicKey = secp256k1.getPublicKey(pkBytes, true)
    return publicKeyToEosFormat(publicKey)
  }

  /**
   * Sign an EOS transaction.
   *
   * The transaction is serialized and signed with SHA-256 + chain_id.
   * Returns the signature in SIG_K1_ format.
   *
   * Extra fields in UnsignedTx:
   * - extra.chainId: string (hex chain ID, required)
   * - extra.expiration: number (unix timestamp)
   * - extra.refBlockNum: number
   * - extra.refBlockPrefix: number
   * - extra.account: string (contract account, default: "eosio.token")
   * - extra.actionName: string (action name, default: "transfer")
   * - extra.permission: string (default: "active")
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
    const pkBytes = hexToBytes(pkHex)

    const chainId = tx.extra?.chainId as string
    if (!chainId) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Chain ID is required for EOS transaction signing (set tx.extra.chainId)',
      )
    }

    // Serialize and create signing digest
    const signingData = serializeTransaction(tx, chainId)
    const digest = sha256(signingData)

    // Sign with secp256k1
    const signature = secp256k1.sign(digest, pkBytes)

    // Encode as SIG_K1_ format
    const compactSig = signature.toCompactRawBytes()
    const eosSig = encodeEosSignature(compactSig, signature.recovery)

    // Return the SIG_K1_ string as the "hex" output
    // (EOS signatures are not raw hex but rather base58-encoded)
    return eosSig
  }

  /**
   * Sign an arbitrary message.
   * Computes SHA-256 of the message and signs with secp256k1.
   * Returns the signature in SIG_K1_ format.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
    const pkBytes = hexToBytes(pkHex)

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    const digest = sha256(msgBytes)
    const signature = secp256k1.sign(digest, pkBytes)

    const compactSig = signature.toCompactRawBytes()
    return encodeEosSignature(compactSig, signature.recovery)
  }
}
