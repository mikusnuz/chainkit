import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
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
 * Well-known Neo N3 contract script hashes (little-endian bytes).
 * These are the native NEP-17 contracts on Neo N3 mainnet.
 */
const NEO_CONTRACT_HASH = 'ef4073a0f2b305a38ec4050e4d3d28bc40ea63f5'
const GAS_CONTRACT_HASH = 'd2a4cff31913016155e38e474a2c06d08be276cf'

/**
 * System.Contract.Call interop hash (little-endian, 4 bytes).
 */
const SYSCALL_CONTRACT_CALL = new Uint8Array([0x62, 0x7d, 0x5b, 0x52])

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
 * Decode a Neo3 address back to its 20-byte script hash (little-endian).
 */
function addressToScriptHash(address: string): Uint8Array {
  const decoded = b58check.decode(address)
  // decoded = version_byte (1) + script_hash (20)
  if (decoded.length !== 21 || decoded[0] !== NEO3_ADDRESS_VERSION) {
    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      `Invalid Neo3 address: ${address}`,
    )
  }
  return decoded.slice(1)
}

/**
 * Encode an integer value using NeoVM push opcodes.
 *
 * NeoVM integer push rules:
 * - -1:       PUSHM1 (0x4f)
 * - 0..16:    PUSH0..PUSH16 (0x10..0x20)
 * - Otherwise: PUSHINT8/16/32/64/128/256 with little-endian two's complement bytes
 */
function emitPushInteger(value: bigint): Uint8Array {
  if (value === -1n) {
    return new Uint8Array([0x4f]) // PUSHM1
  }
  if (value >= 0n && value <= 16n) {
    return new Uint8Array([0x10 + Number(value)]) // PUSH0..PUSH16
  }

  // Determine minimum byte length for two's complement
  const parts: number[] = []
  let v = value
  if (value >= 0n) {
    while (v > 0n) {
      parts.push(Number(v & 0xffn))
      v >>= 8n
    }
    // If high bit set, add zero padding for positive numbers
    if (parts.length > 0 && (parts[parts.length - 1] & 0x80) !== 0) {
      parts.push(0)
    }
  } else {
    // Negative: fill with two's complement
    while (v < -1n) {
      parts.push(Number(v & 0xffn))
      v >>= 8n
    }
    parts.push(0xff) // sign byte
  }

  // Round up to valid NeoVM integer sizes: 1, 2, 4, 8, 16, 32
  let byteLen = parts.length
  if (byteLen <= 1) byteLen = 1
  else if (byteLen <= 2) byteLen = 2
  else if (byteLen <= 4) byteLen = 4
  else if (byteLen <= 8) byteLen = 8
  else if (byteLen <= 16) byteLen = 16
  else byteLen = 32

  // Opcode for integer size: PUSHINT8=0x00, PUSHINT16=0x01, PUSHINT32=0x02,
  // PUSHINT64=0x03, PUSHINT128=0x04, PUSHINT256=0x05
  let opcode: number
  switch (byteLen) {
    case 1: opcode = 0x00; break   // PUSHINT8
    case 2: opcode = 0x01; break   // PUSHINT16
    case 4: opcode = 0x02; break   // PUSHINT32
    case 8: opcode = 0x03; break   // PUSHINT64
    case 16: opcode = 0x04; break  // PUSHINT128
    default: opcode = 0x05; break  // PUSHINT256
  }

  const buf = new Uint8Array(1 + byteLen)
  buf[0] = opcode
  // Fill with little-endian value bytes; padding is 0x00 for positive, 0xff for negative
  const padByte = value >= 0n ? 0 : 0xff
  for (let i = 0; i < byteLen; i++) {
    buf[1 + i] = i < parts.length ? parts[i] : padByte
  }
  return buf
}

/**
 * Emit PUSHDATA for raw byte arrays (script hashes, strings).
 * Uses the smallest PUSHDATA variant that fits.
 *
 * - 1..75 bytes: PUSHDATA1 (0x0c) + uint8 length
 * - 76..255 bytes: PUSHDATA1 (0x0c) + uint8 length
 * - 256..65535 bytes: PUSHDATA2 (0x0d) + uint16 LE length
 */
function emitPushData(data: Uint8Array): Uint8Array {
  if (data.length <= 0xff) {
    const buf = new Uint8Array(2 + data.length)
    buf[0] = 0x0c // PUSHDATA1
    buf[1] = data.length
    buf.set(data, 2)
    return buf
  } else if (data.length <= 0xffff) {
    const buf = new Uint8Array(3 + data.length)
    buf[0] = 0x0d // PUSHDATA2
    buf[1] = data.length & 0xff
    buf[2] = (data.length >> 8) & 0xff
    buf.set(data, 3)
    return buf
  }
  throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'Data too large for PUSHDATA')
}

/**
 * Build a NEP-17 transfer NeoVM script.
 *
 * The NeoVM calling convention for System.Contract.Call:
 *   1. Push arguments in REVERSE order onto the stack
 *   2. Push arg count, then PACK into an array
 *   3. Push CallFlags (0x0f = All)
 *   4. Push method name as string
 *   5. Push contract hash (20 bytes)
 *   6. SYSCALL System.Contract.Call
 *
 * For NEP-17 transfer(from, to, amount, data):
 *   Arguments reversed: data(null), amount, to, from
 *   Then: PUSH4, PACK, PUSHINT(0x0f), PUSHDATA("transfer"), PUSHDATA(contract), SYSCALL
 */
function buildTransferScript(
  contractHash: Uint8Array,
  fromHash: Uint8Array,
  toHash: Uint8Array,
  amount: bigint,
): Uint8Array {
  const parts: Uint8Array[] = []

  // Push arguments in reverse order for the transfer(from, to, amount, data) method
  // Arg 4 (data): null - PUSHNULL opcode
  parts.push(new Uint8Array([0x0b])) // PUSHNULL

  // Arg 3 (amount): integer
  parts.push(emitPushInteger(amount))

  // Arg 2 (to): 20-byte script hash
  parts.push(emitPushData(toHash))

  // Arg 1 (from): 20-byte script hash
  parts.push(emitPushData(fromHash))

  // Push arg count (4) and PACK
  parts.push(new Uint8Array([0x14])) // PUSH4
  parts.push(new Uint8Array([0xc1])) // PACK

  // Push CallFlags.All (0x0f)
  parts.push(new Uint8Array([0x1f])) // PUSH15 (0x0f = 15)

  // Push method name "transfer"
  const methodBytes = new TextEncoder().encode('transfer')
  parts.push(emitPushData(methodBytes))

  // Push contract hash (20 bytes)
  parts.push(emitPushData(contractHash))

  // SYSCALL System.Contract.Call (0x41 + 4-byte interop hash)
  const syscall = new Uint8Array(5)
  syscall[0] = 0x41 // SYSCALL
  syscall.set(SYSCALL_CONTRACT_CALL, 1)
  parts.push(syscall)

  return concatBytes(...parts)
}

/**
 * Resolve the contract hash for a given asset name.
 * Supports "NEO", "GAS", or a raw hex script hash (with or without 0x prefix).
 */
function resolveContractHash(asset: string): Uint8Array {
  const upper = asset.toUpperCase()
  if (upper === 'NEO') {
    return reverseBytes(hexToBytes(NEO_CONTRACT_HASH))
  }
  if (upper === 'GAS') {
    return reverseBytes(hexToBytes(GAS_CONTRACT_HASH))
  }
  // Treat as a raw hex script hash (big-endian 0x-prefixed or plain)
  const cleaned = stripHexPrefix(asset)
  if (cleaned.length !== 40) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid contract hash: ${asset}`,
    )
  }
  // Convert from big-endian display format to little-endian internal format
  return reverseBytes(hexToBytes(cleaned))
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
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    // Extract Neo-specific fields from the transaction
    const version = 0
    const nonce = tx.nonce ?? 0
    const systemFee = BigInt(tx.fee?.systemFee as string ?? '0')
    const networkFee = BigInt(tx.fee?.networkFee as string ?? '0')
    const validUntilBlock = Number(tx.extra?.validUntilBlock ?? 0)
    const networkMagic = Number(tx.extra?.networkMagic ?? 860833102) // Neo3 mainnet magic

    // Build signer account (script hash of the sender)
    const compressedPubKey = p256.getPublicKey(pkBytes, true)
    const vScript = buildVerificationScript(compressedPubKey)
    const senderScriptHash = getScriptHash(vScript)

    // Build the NeoVM script
    let script: Uint8Array
    if (tx.data) {
      // Raw script provided directly
      script = hexToBytes(stripHexPrefix(tx.data as string))
    } else if (tx.to && tx.value) {
      // Build a NEP-17 transfer script from to/value/asset fields
      const asset = (tx.extra?.asset as string) ?? 'GAS'
      const contractHash = resolveContractHash(asset)
      const toScriptHash = addressToScriptHash(tx.to)
      const amount = BigInt(tx.value as string)
      script = buildTransferScript(contractHash, senderScriptHash, toScriptHash, amount)
    } else {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Transaction must have either data (raw script) or to + value (NEP-17 transfer)',
      )
    }

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
      encodeVarBytes(vScript),                           // verification script
    )

    return addHexPrefix(bytesToHex(signedTx))
  }

  /**
   * Validate a Neo N3 address.
   * Neo3 addresses are base58check-encoded with version byte 0x35,
   * starting with 'N' and 34 characters long.
   */
  validateAddress(address: string): boolean {
    try {
      if (!address.startsWith('N') || address.length !== 34) return false
      const decoded = b58check.decode(address)
      return decoded.length === 21 && decoded[0] === NEO3_ADDRESS_VERSION
    } catch {
      return false
    }
  }

  /**
   * Sign an arbitrary message with P-256.
   * Uses SHA-256 hash of the message before signing.
   * Returns the signature as r (32 bytes) + s (32 bytes) = 64 bytes hex.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
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
