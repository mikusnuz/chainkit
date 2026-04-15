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

// ---------------------------------------------------------------------------
// Minimal protobuf encoder
// Implements only the primitives needed for Cosmos SDK transaction serialization.
// Reference: https://github.com/cosmos/cosmos-sdk/blob/main/proto/cosmos/tx/v1beta1/tx.proto
// ---------------------------------------------------------------------------

/** Protobuf wire type: varint (int32, int64, uint32, uint64, bool, enum) */
const WIRE_VARINT = 0
/** Protobuf wire type: length-delimited (string, bytes, embedded messages) */
const WIRE_LENGTH_DELIMITED = 2

/**
 * Concatenate multiple Uint8Arrays into one.
 */
function concat(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0
  for (const arr of arrays) {
    totalLength += arr.length
  }
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/**
 * Encode an unsigned integer as a protobuf varint.
 */
function encodeVarint(value: number | bigint): Uint8Array {
  const bytes: number[] = []
  let v = typeof value === 'bigint' ? value : BigInt(value)
  do {
    let byte = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) byte |= 0x80
    bytes.push(byte)
  } while (v > 0n)
  return new Uint8Array(bytes)
}

/**
 * Encode a single protobuf field with a given wire type.
 */
function encodeField(fieldNumber: number, wireType: number, data: Uint8Array): Uint8Array {
  const tag = encodeVarint((fieldNumber << 3) | wireType)
  if (wireType === WIRE_LENGTH_DELIMITED) {
    return concat(tag, encodeVarint(data.length), data)
  }
  return concat(tag, data)
}

/**
 * Encode a string field (length-delimited).
 */
function encodeString(fieldNumber: number, value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array(0)
  return encodeField(fieldNumber, WIRE_LENGTH_DELIMITED, new TextEncoder().encode(value))
}

/**
 * Encode a bytes field (length-delimited).
 */
function encodeBytes(fieldNumber: number, value: Uint8Array): Uint8Array {
  if (value.length === 0) return new Uint8Array(0)
  return encodeField(fieldNumber, WIRE_LENGTH_DELIMITED, value)
}

/**
 * Encode a varint field.
 */
function encodeUint64Field(fieldNumber: number, value: number | bigint): Uint8Array {
  if (value === 0 || value === 0n) return new Uint8Array(0)
  return encodeField(fieldNumber, WIRE_VARINT, encodeVarint(value))
}

/**
 * Encode an embedded message field (length-delimited wrapper around concatenated inner fields).
 */
function encodeMessage(fieldNumber: number, ...fields: Uint8Array[]): Uint8Array {
  const data = concat(...fields)
  return encodeField(fieldNumber, WIRE_LENGTH_DELIMITED, data)
}

// ---------------------------------------------------------------------------
// Cosmos SDK protobuf message builders
// ---------------------------------------------------------------------------

/**
 * Encode a cosmos.base.v1beta1.Coin message (not wrapped in a field tag).
 * Coin { denom: string (1), amount: string (2) }
 */
function encodeCoinRaw(denom: string, amount: string): Uint8Array {
  return concat(
    encodeString(1, denom),
    encodeString(2, amount),
  )
}

/**
 * Encode cosmos.bank.v1beta1.MsgSend.
 * MsgSend {
 *   from_address: string (1)
 *   to_address:   string (2)
 *   amount:       repeated Coin (3)
 * }
 */
function encodeMsgSend(fromAddress: string, toAddress: string, amount: Array<{ denom: string; amount: string }>): Uint8Array {
  const fields: Uint8Array[] = [
    encodeString(1, fromAddress),
    encodeString(2, toAddress),
  ]
  for (const coin of amount) {
    fields.push(encodeMessage(3, encodeCoinRaw(coin.denom, coin.amount)))
  }
  return concat(...fields)
}

/**
 * Encode a google.protobuf.Any message (not wrapped in a field tag).
 * Any { type_url: string (1), value: bytes (2) }
 */
function encodeAnyRaw(typeUrl: string, value: Uint8Array): Uint8Array {
  return concat(
    encodeString(1, typeUrl),
    encodeBytes(2, value),
  )
}

/**
 * Encode cosmos.tx.v1beta1.TxBody.
 * TxBody {
 *   messages: repeated Any (1)
 *   memo:     string (2)
 * }
 */
function encodeTxBody(messages: Array<{ typeUrl: string; value: Uint8Array }>, memo: string): Uint8Array {
  const fields: Uint8Array[] = []
  for (const msg of messages) {
    fields.push(encodeMessage(1, encodeAnyRaw(msg.typeUrl, msg.value)))
  }
  if (memo.length > 0) {
    fields.push(encodeString(2, memo))
  }
  return concat(...fields)
}

/**
 * Encode cosmos.tx.v1beta1.AuthInfo.
 * AuthInfo {
 *   signer_infos: repeated SignerInfo (1)
 *   fee:          Fee (2)
 * }
 *
 * SignerInfo {
 *   public_key: Any (1)
 *   mode_info:  ModeInfo (2)
 *   sequence:   uint64 (3)
 * }
 *
 * ModeInfo { single: Single (1) }
 * Single { mode: SignMode (1) }   -- SIGN_MODE_DIRECT = 1
 *
 * Fee {
 *   amount:    repeated Coin (1)
 *   gas_limit: uint64 (2)
 * }
 *
 * PubKey (secp256k1) { key: bytes (1) }
 */
function encodeAuthInfo(
  publicKey: Uint8Array,
  sequence: number,
  feeAmount: Array<{ denom: string; amount: string }>,
  gasLimit: number | bigint,
): Uint8Array {
  // PubKey { key: bytes (1) }
  const pubKeyValue = encodeBytes(1, publicKey)

  // Any { type_url (1), value (2) } for the public key
  const pubKeyAny = encodeAnyRaw('/cosmos.crypto.secp256k1.PubKey', pubKeyValue)

  // ModeInfo.Single { mode: SIGN_MODE_DIRECT = 1 }
  const singleMode = encodeUint64Field(1, 1)
  // ModeInfo { single (1) }
  const modeInfo = encodeMessage(1, singleMode)

  // SignerInfo { public_key (1), mode_info (2), sequence (3) }
  const signerInfoFields: Uint8Array[] = [
    encodeMessage(1, pubKeyAny),
    encodeMessage(2, modeInfo),
  ]
  if (sequence > 0) {
    signerInfoFields.push(encodeUint64Field(3, sequence))
  }
  const signerInfo = concat(...signerInfoFields)

  // Fee { amount (1), gas_limit (2) }
  const feeFields: Uint8Array[] = []
  for (const coin of feeAmount) {
    feeFields.push(encodeMessage(1, encodeCoinRaw(coin.denom, coin.amount)))
  }
  if (gasLimit > 0) {
    feeFields.push(encodeUint64Field(2, gasLimit))
  }
  const fee = concat(...feeFields)

  // AuthInfo { signer_infos (1), fee (2) }
  return concat(
    encodeMessage(1, signerInfo),
    encodeMessage(2, fee),
  )
}

/**
 * Encode cosmos.tx.v1beta1.SignDoc.
 * SignDoc {
 *   body_bytes:      bytes (1)
 *   auth_info_bytes: bytes (2)
 *   chain_id:        string (3)
 *   account_number:  uint64 (4)
 * }
 */
function encodeSignDoc(
  bodyBytes: Uint8Array,
  authInfoBytes: Uint8Array,
  chainId: string,
  accountNumber: number,
): Uint8Array {
  return concat(
    encodeBytes(1, bodyBytes),
    encodeBytes(2, authInfoBytes),
    encodeString(3, chainId),
    encodeUint64Field(4, accountNumber),
  )
}

/**
 * Encode cosmos.tx.v1beta1.TxRaw.
 * TxRaw {
 *   body_bytes:      bytes (1)
 *   auth_info_bytes: bytes (2)
 *   signatures:      repeated bytes (3)
 * }
 */
function encodeTxRaw(
  bodyBytes: Uint8Array,
  authInfoBytes: Uint8Array,
  signatures: Uint8Array[],
): Uint8Array {
  const fields: Uint8Array[] = [
    encodeBytes(1, bodyBytes),
    encodeBytes(2, authInfoBytes),
  ]
  for (const sig of signatures) {
    fields.push(encodeBytes(3, sig))
  }
  return concat(...fields)
}

/**
 * Cosmos signer implementing the ChainSigner interface.
 * Supports BIP39/BIP32 key derivation, secp256k1 signing,
 * and bech32 address generation with the "cosmos" prefix.
 *
 * Transaction signing produces a valid protobuf-encoded TxRaw
 * containing body_bytes, auth_info_bytes, and a secp256k1 signature.
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
   * Sign a Cosmos transaction and produce a protobuf-encoded TxRaw.
   *
   * The UnsignedTx is mapped to Cosmos transaction fields as follows:
   *   - tx.from: sender address (MsgSend.from_address)
   *   - tx.to:   recipient address (MsgSend.to_address)
   *   - tx.value: transfer amount in smallest denomination
   *   - tx.fee:  { amount, denom, gas } for the transaction fee
   *   - tx.extra: { chainId, accountNumber, sequence, memo, messages }
   *
   * When tx.extra.messages is provided, those messages are used directly.
   * Otherwise a single bank.MsgSend is constructed from from/to/value.
   *
   * Returns a '0x'-prefixed hex string of the protobuf-encoded TxRaw.
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

    const publicKey = secp256k1.getPublicKey(pkBytes, true)

    // Extract Cosmos-specific fields from extra
    const extra = tx.extra ?? {}
    const chainId = (extra.chainId as string) ?? ''
    const accountNumber = (extra.accountNumber as number) ?? 0
    const sequence = (extra.sequence as number) ?? 0
    const memo = (extra.memo as string) ?? ''

    // Fee parameters
    const feeDenom = (tx.fee?.denom as string) ?? 'uatom'
    const feeAmount = (tx.fee?.fee as string) ?? (tx.fee?.amount as string) ?? '0'
    const gasLimit = parseInt((tx.fee?.gasLimit as string) ?? (tx.fee?.gas as string) ?? '200000', 10)

    // Build messages
    let protoMessages: Array<{ typeUrl: string; value: Uint8Array }>

    if (extra.messages && Array.isArray(extra.messages)) {
      // Use pre-built messages from extra (each must have typeUrl and value)
      protoMessages = (extra.messages as Array<{ typeUrl: string; value: Uint8Array }>)
    } else {
      // Default: build a single MsgSend from from/to/value
      const denom = (extra.denom as string) ?? feeDenom
      const msgSendBytes = encodeMsgSend(tx.from ?? '', tx.to, [
        { denom, amount: tx.value ?? tx.amount ?? '0' },
      ])
      protoMessages = [
        { typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: msgSendBytes },
      ]
    }

    // Encode TxBody
    const bodyBytes = encodeTxBody(protoMessages, memo)

    // Encode AuthInfo
    const authInfoBytes = encodeAuthInfo(
      publicKey,
      sequence,
      [{ denom: feeDenom, amount: feeAmount }],
      gasLimit,
    )

    // Encode SignDoc
    const signDocBytes = encodeSignDoc(bodyBytes, authInfoBytes, chainId, accountNumber)

    // SHA-256 hash of the SignDoc, then sign with secp256k1
    const signDocHash = sha256(signDocBytes)
    const signature = secp256k1.sign(signDocHash, pkBytes)

    // Extract compact signature: r (32 bytes) || s (32 bytes) = 64 bytes
    const sigBytes = signature.toCompactRawBytes()

    // Build TxRaw
    const txRawBytes = encodeTxRaw(bodyBytes, authInfoBytes, [sigBytes])

    return addHexPrefix(bytesToHex(txRawBytes))
  }

  /**
   * Validate a Cosmos bech32 address.
   * Verifies bech32 encoding and that the prefix matches.
   */
  validateAddress(address: string): boolean {
    try {
      const decoded = bech32.decodeUnsafe(address as `${string}1${string}`)
      if (!decoded) return false
      if (decoded.prefix !== this.prefix) return false
      const data = bech32.fromWords(decoded.words)
      return data.length === 20
    } catch {
      return false
    }
  }

  /**
   * Sign an arbitrary message.
   * Uses the Cosmos ADR-036 style: SHA-256 hash of the message bytes.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
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

// Export protobuf helpers for advanced usage and testing
export {
  encodeVarint,
  encodeField,
  encodeString,
  encodeBytes,
  encodeUint64Field,
  encodeMessage,
  encodeCoinRaw,
  encodeMsgSend,
  encodeAnyRaw,
  encodeTxBody,
  encodeAuthInfo,
  encodeSignDoc,
  encodeTxRaw,
  concat,
}
