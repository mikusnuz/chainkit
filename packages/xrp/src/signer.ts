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
import { sha512 } from '@noble/hashes/sha512'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as secp256k1 from '@noble/secp256k1'
import { base58xrp } from '@scure/base'

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
 * base58check encode using XRP's custom alphabet.
 * Computes SHA-256(SHA-256(payload)) checksum and appends 4 bytes.
 */
function xrpBase58CheckEncode(payload: Uint8Array): string {
  const hash1 = sha256(payload)
  const hash2 = sha256(hash1)
  const checksum = hash2.slice(0, 4)
  const withChecksum = new Uint8Array(payload.length + 4)
  withChecksum.set(payload, 0)
  withChecksum.set(checksum, payload.length)
  return base58xrp.encode(withChecksum)
}

/**
 * base58check decode using XRP's custom alphabet.
 * Verifies the 4-byte checksum.
 */
function xrpBase58CheckDecode(encoded: string): Uint8Array {
  const decoded = base58xrp.decode(encoded)
  const payload = decoded.slice(0, decoded.length - 4)
  const checksum = decoded.slice(decoded.length - 4)
  const hash1 = sha256(payload)
  const hash2 = sha256(hash1)
  const expectedChecksum = hash2.slice(0, 4)
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) {
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        'Invalid base58check checksum',
      )
    }
  }
  return payload
}

/**
 * Compute the Account ID (20 bytes) from a compressed public key.
 * Process: pubkey -> SHA-256 -> RIPEMD-160 -> 20-byte account ID.
 */
function publicKeyToAccountId(publicKey: Uint8Array): Uint8Array {
  const hash256 = sha256(publicKey)
  return ripemd160(hash256)
}

/**
 * Encode an Account ID as an XRP address (base58check with 0x00 prefix).
 */
function accountIdToAddress(accountId: Uint8Array): string {
  // XRP addresses use a type prefix byte of 0x00
  const payload = new Uint8Array(1 + accountId.length)
  payload[0] = 0x00
  payload.set(accountId, 1)
  return xrpBase58CheckEncode(payload)
}

/**
 * Decode an XRP address to a 20-byte account ID.
 */
function decodeXrpAddress(address: string): Uint8Array {
  const decoded = xrpBase58CheckDecode(address)
  // First byte is the type prefix (0x00), remaining 20 bytes are the account ID
  return decoded.slice(1, 21)
}

/**
 * Encode a secp256k1 signature as DER format.
 * DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
 */
function signatureToDER(r: bigint, s: bigint): Uint8Array {
  const rBytes = bigintToBytes(r)
  const sBytes = bigintToBytes(s)

  // DER requires that integers are signed, so add a 0x00 byte if high bit is set
  const rPadded = rBytes[0] >= 0x80 ? new Uint8Array([0x00, ...rBytes]) : rBytes
  const sPadded = sBytes[0] >= 0x80 ? new Uint8Array([0x00, ...sBytes]) : sBytes

  const totalLength = 2 + rPadded.length + 2 + sPadded.length
  const der = new Uint8Array(2 + totalLength)
  der[0] = 0x30 // SEQUENCE
  der[1] = totalLength
  der[2] = 0x02 // INTEGER
  der[3] = rPadded.length
  der.set(rPadded, 4)
  der[4 + rPadded.length] = 0x02 // INTEGER
  der[5 + rPadded.length] = sPadded.length
  der.set(sPadded, 6 + rPadded.length)
  return der
}

/**
 * Convert a bigint to minimal bytes representation.
 */
function bigintToBytes(n: bigint): Uint8Array {
  let hex = n.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return hexToBytes(hex)
}

// ---- XRP Binary Serialization ----

/**
 * XRP field types and their type codes / field codes for canonical serialization.
 * Reference: https://xrpl.org/serialization.html
 */
const FIELD_IDS: Record<string, [number, number]> = {
  // [typeCode, fieldCode]
  TransactionType: [1, 2],
  Flags: [2, 2],
  Sequence: [2, 4],
  DestinationTag: [2, 14],
  LastLedgerSequence: [2, 27],
  Amount: [6, 1],
  Fee: [6, 8],
  SigningPubKey: [7, 3],
  TxnSignature: [7, 4],
  Account: [8, 1],
  Destination: [8, 3],
}

/**
 * XRP transaction type codes.
 */
const TX_TYPES: Record<string, number> = {
  Payment: 0,
  EscrowCreate: 1,
  EscrowFinish: 2,
  AccountSet: 3,
  EscrowCancel: 4,
  SetRegularKey: 5,
  NickNameSet: 6,
  OfferCreate: 7,
  OfferCancel: 8,
  SignerListSet: 12,
  PaymentChannelCreate: 13,
  PaymentChannelFund: 14,
  PaymentChannelClaim: 15,
  CheckCreate: 16,
  CheckCash: 17,
  CheckCancel: 18,
  DepositPreauth: 19,
  TrustSet: 20,
}

/**
 * Encode a field ID header for XRP binary serialization.
 */
function encodeFieldId(typeCode: number, fieldCode: number): Uint8Array {
  if (typeCode < 16 && fieldCode < 16) {
    return new Uint8Array([(typeCode << 4) | fieldCode])
  } else if (typeCode < 16) {
    return new Uint8Array([(typeCode << 4), fieldCode])
  } else if (fieldCode < 16) {
    return new Uint8Array([fieldCode, typeCode])
  } else {
    return new Uint8Array([0, typeCode, fieldCode])
  }
}

/**
 * Encode a UInt16 field.
 */
function encodeUInt16(fieldName: string, value: number): Uint8Array {
  const [typeCode, fieldCode] = FIELD_IDS[fieldName]
  const header = encodeFieldId(typeCode, fieldCode)
  const result = new Uint8Array(header.length + 2)
  result.set(header, 0)
  result[header.length] = (value >> 8) & 0xff
  result[header.length + 1] = value & 0xff
  return result
}

/**
 * Encode a UInt32 field.
 */
function encodeUInt32(fieldName: string, value: number): Uint8Array {
  const [typeCode, fieldCode] = FIELD_IDS[fieldName]
  const header = encodeFieldId(typeCode, fieldCode)
  const result = new Uint8Array(header.length + 4)
  result.set(header, 0)
  result[header.length] = (value >> 24) & 0xff
  result[header.length + 1] = (value >> 16) & 0xff
  result[header.length + 2] = (value >> 8) & 0xff
  result[header.length + 3] = value & 0xff
  return result
}

/**
 * Encode an XRP amount (native drops) as 8-byte field.
 * Positive XRP amounts have bit 62 set and bit 63 clear.
 */
function encodeXrpAmount(fieldName: string, drops: string): Uint8Array {
  const [typeCode, fieldCode] = FIELD_IDS[fieldName]
  const header = encodeFieldId(typeCode, fieldCode)
  const value = BigInt(drops)

  // For positive XRP amounts: set bit 62 (0x4000000000000000)
  const encoded = value | 0x4000000000000000n
  const result = new Uint8Array(header.length + 8)
  result.set(header, 0)

  const hex = encoded.toString(16).padStart(16, '0')
  const bytes = hexToBytes(hex)
  result.set(bytes, header.length)
  return result
}

/**
 * Encode a variable-length field (VL encoded).
 */
function encodeVL(data: Uint8Array): Uint8Array {
  const len = data.length
  if (len <= 192) {
    const result = new Uint8Array(1 + len)
    result[0] = len
    result.set(data, 1)
    return result
  } else if (len <= 12480) {
    const adjusted = len - 193
    const byte1 = 193 + (adjusted >> 8)
    const byte2 = adjusted & 0xff
    const result = new Uint8Array(2 + len)
    result[0] = byte1
    result[1] = byte2
    result.set(data, 2)
    return result
  } else {
    const adjusted = len - 12481
    const byte1 = 241 + (adjusted >> 16)
    const byte2 = (adjusted >> 8) & 0xff
    const byte3 = adjusted & 0xff
    const result = new Uint8Array(3 + len)
    result[0] = byte1
    result[1] = byte2
    result[2] = byte3
    result.set(data, 3)
    return result
  }
}

/**
 * Encode a Blob (variable-length bytes) field.
 */
function encodeBlob(fieldName: string, data: Uint8Array): Uint8Array {
  const [typeCode, fieldCode] = FIELD_IDS[fieldName]
  const header = encodeFieldId(typeCode, fieldCode)
  const vlEncoded = encodeVL(data)
  const result = new Uint8Array(header.length + vlEncoded.length)
  result.set(header, 0)
  result.set(vlEncoded, header.length)
  return result
}

/**
 * Encode an AccountID field (VL-encoded 20-byte account ID).
 */
function encodeAccountId(fieldName: string, address: string): Uint8Array {
  const [typeCode, fieldCode] = FIELD_IDS[fieldName]
  const header = encodeFieldId(typeCode, fieldCode)
  const accountId = decodeXrpAddress(address)
  const vlEncoded = encodeVL(accountId)
  const result = new Uint8Array(header.length + vlEncoded.length)
  result.set(header, 0)
  result.set(vlEncoded, header.length)
  return result
}

/**
 * Concatenate multiple Uint8Arrays.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/**
 * Canonical field ordering: sort by type code first, then field code.
 */
function fieldSortKey(fieldName: string): number {
  const [typeCode, fieldCode] = FIELD_IDS[fieldName]
  return (typeCode << 16) | fieldCode
}

/**
 * Serialize an XRP transaction into canonical binary format.
 */
function serializeTransaction(
  fields: Array<{ name: string; encode: () => Uint8Array }>,
): Uint8Array {
  // Sort fields by canonical order
  const sorted = [...fields].sort((a, b) => fieldSortKey(a.name) - fieldSortKey(b.name))
  return concatBytes(...sorted.map((f) => f.encode()))
}

/**
 * Hash prefix for signing (0x53545800 = "STX\0").
 */
const HASH_PREFIX_SIGN = new Uint8Array([0x53, 0x54, 0x58, 0x00])

/**
 * XRP Ledger signer implementing the ChainSigner interface.
 * Uses secp256k1 key derivation with XRP-specific address encoding.
 *
 * Default HD path: m/44'/144'/0'/0/0
 */
export class XrpSigner implements ChainSigner {
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
   * Default XRP path: m/44'/144'/0'/0/0
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return addHexPrefix(privateKeyHex)
  }

  /**
   * Get the XRP address for a given private key.
   * Process: privkey -> secp256k1 compressed pubkey -> SHA-256 -> RIPEMD-160 -> base58check
   */
  getAddress(privateKey: HexString): Address {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get compressed public key (33 bytes)
    const publicKey = secp256k1.getPublicKey(pkBytes, true)
    const accountId = publicKeyToAccountId(publicKey)
    return accountIdToAddress(accountId)
  }

  /**
   * Sign an XRP transaction.
   *
   * The UnsignedTx should contain:
   * - from: sender XRP address
   * - to: destination XRP address
   * - value: amount in drops
   * - fee.fee: fee in drops
   * - nonce: account sequence number
   * - extra.destinationTag: optional destination tag
   * - extra.lastLedgerSequence: optional last ledger sequence
   *
   * Returns the signed transaction blob as a hex string.
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    const publicKey = secp256k1.getPublicKey(pkBytes, true)

    const txType = (tx.extra?.transactionType as string) ?? 'Payment'
    const txTypeCode = TX_TYPES[txType]
    if (txTypeCode === undefined) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        `Unsupported transaction type: ${txType}`,
      )
    }

    const sequence = tx.nonce ?? 0
    const fee = tx.fee?.fee ?? '12'
    const amount = tx.value ?? '0'
    const flags = (tx.extra?.flags as number) ?? 0

    // Build field list for signing (without TxnSignature)
    const fields: Array<{ name: string; encode: () => Uint8Array }> = [
      { name: 'TransactionType', encode: () => encodeUInt16('TransactionType', txTypeCode) },
      { name: 'Flags', encode: () => encodeUInt32('Flags', flags) },
      { name: 'Sequence', encode: () => encodeUInt32('Sequence', sequence) },
      { name: 'Amount', encode: () => encodeXrpAmount('Amount', amount) },
      { name: 'Fee', encode: () => encodeXrpAmount('Fee', fee) },
      { name: 'SigningPubKey', encode: () => encodeBlob('SigningPubKey', publicKey) },
      { name: 'Account', encode: () => encodeAccountId('Account', tx.from) },
      { name: 'Destination', encode: () => encodeAccountId('Destination', tx.to) },
    ]

    // Optional fields
    const destinationTag = tx.extra?.destinationTag as number | undefined
    if (destinationTag !== undefined) {
      fields.push({
        name: 'DestinationTag',
        encode: () => encodeUInt32('DestinationTag', destinationTag),
      })
    }

    const lastLedgerSequence = tx.extra?.lastLedgerSequence as number | undefined
    if (lastLedgerSequence !== undefined) {
      fields.push({
        name: 'LastLedgerSequence',
        encode: () => encodeUInt32('LastLedgerSequence', lastLedgerSequence),
      })
    }

    // Serialize for signing
    const serialized = serializeTransaction(fields)

    // Hash: HASH_PREFIX_SIGN + serialized, then SHA-512Half
    // XRP uses SHA-512 and takes first 32 bytes (SHA-512Half)
    // However, for secp256k1 signing, the message must be 32 bytes
    // XRP actually uses the half-SHA-512 of the signing prefix + serialized data
    const signingData = concatBytes(HASH_PREFIX_SIGN, serialized)
    const hash = sha512(signingData).slice(0, 32)

    // Sign with secp256k1
    const signature = secp256k1.sign(hash, pkBytes)

    // Encode signature as DER
    const derSignature = signatureToDER(signature.r, signature.s)

    // Build the full signed transaction (with TxnSignature field)
    fields.push({
      name: 'TxnSignature',
      encode: () => encodeBlob('TxnSignature', derSignature),
    })

    const signedSerialized = serializeTransaction(fields)
    return addHexPrefix(bytesToHex(signedSerialized))
  }

  /**
   * Sign an arbitrary message.
   * XRP does not have a standardized message signing format like Ethereum's EIP-191,
   * so we use a simple SHA-256 double hash of the message and sign with secp256k1.
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Double SHA-256 hash (consistent with XRP's hashing convention)
    const hash = sha256(sha256(msgBytes))

    const signature = secp256k1.sign(hash, pkBytes)

    // Return DER-encoded signature as hex
    const derSig = signatureToDER(signature.r, signature.s)
    return addHexPrefix(bytesToHex(derSig))
  }
}
