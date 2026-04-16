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

/**
 * Compute the HASH160 of data: RIPEMD-160(SHA-256(data)).
 */
function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data))
}

/**
 * Double SHA-256 hash.
 */
function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data))
}

/**
 * Encode a byte array to a bech32 address (P2WPKH, witness version 0).
 * @param hrp - Human-readable part ("bc" for mainnet, "tb" for testnet)
 * @param witnessProgram - 20-byte witness program (HASH160 of compressed pubkey)
 */
function encodeBech32Address(hrp: string, witnessProgram: Uint8Array): string {
  // Convert 8-bit data to 5-bit words
  const words = bech32.toWords(witnessProgram)
  // Prepend witness version 0
  words.unshift(0)
  return bech32.encode(hrp, words)
}

/**
 * Encode data as a variable-length integer (Bitcoin VarInt).
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
  throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'VarInt too large')
}

/**
 * Write a 32-bit little-endian unsigned integer to a Uint8Array.
 */
function writeUint32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  buf[0] = value & 0xff
  buf[1] = (value >> 8) & 0xff
  buf[2] = (value >> 16) & 0xff
  buf[3] = (value >> 24) & 0xff
  return buf
}

/**
 * Write a 64-bit little-endian unsigned integer to a Uint8Array (using BigInt for safety).
 */
function writeUint64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    buf[i] = Number((value >> BigInt(i * 8)) & 0xffn)
  }
  return buf
}

/**
 * Concatenate multiple Uint8Arrays.
 */
function concat(...arrays: Uint8Array[]): Uint8Array {
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
 * Reverse a Uint8Array (for converting txid hex to internal byte order).
 */
function reverseBytes(bytes: Uint8Array): Uint8Array {
  const reversed = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    reversed[i] = bytes[bytes.length - 1 - i]
  }
  return reversed
}

/**
 * Create a P2WPKH scriptPubKey: OP_0 <20-byte-hash>
 */
function createP2WPKHScriptPubKey(pubkeyHash: Uint8Array): Uint8Array {
  // OP_0 (0x00) + push 20 bytes (0x14) + 20-byte hash
  return concat(new Uint8Array([0x00, 0x14]), pubkeyHash)
}

/**
 * DER-encode an ECDSA signature (r, s) as per BIP66.
 * Format: 0x30 [total-len] 0x02 [r-len] [r] 0x02 [s-len] [s]
 */
function derEncodeSignature(r: bigint, s: bigint): Uint8Array {
  const rBytes = bigintToMinimalBytes(r)
  const sBytes = bigintToMinimalBytes(s)

  // If high bit is set, prepend a zero byte
  const rPadded = rBytes[0] >= 0x80 ? concat(new Uint8Array([0x00]), rBytes) : rBytes
  const sPadded = sBytes[0] >= 0x80 ? concat(new Uint8Array([0x00]), sBytes) : sBytes

  const totalLen = 2 + rPadded.length + 2 + sPadded.length

  return concat(
    new Uint8Array([0x30, totalLen, 0x02, rPadded.length]),
    rPadded,
    new Uint8Array([0x02, sPadded.length]),
    sPadded,
  )
}

/**
 * Convert a BigInt to minimal big-endian byte representation.
 */
function bigintToMinimalBytes(n: bigint): Uint8Array {
  let hex = n.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return hexToBytes(hex)
}

/**
 * Bitcoin signer implementing the ChainSigner interface.
 * Supports BIP39/BIP32 key derivation, Bitcoin message signing,
 * and SegWit (P2WPKH) transaction signing.
 */
export class BitcoinSigner implements ChainSigner {
  private readonly network: 'mainnet' | 'testnet'

  constructor(network: 'mainnet' | 'testnet' = 'mainnet') {
    this.network = network
  }

  /**
   * Get the default BIP84 HD derivation path for Bitcoin.
   * Mainnet: m/84'/0'/0'/0/0 (BIP84 native SegWit)
   * Testnet: m/84'/1'/0'/0/0 (coin type 1 for all testnets)
   */
  getDefaultHdPath(): string {
    return this.network === 'testnet'
      ? "m/84'/1'/0'/0/0"
      : "m/84'/0'/0'/0/0"
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
   * Get the Bitcoin address for a given private key.
   * Returns a P2WPKH bech32 address (bc1q...) by default.
   */
  getAddress(privateKey: HexString): Address {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get the compressed public key (33 bytes: 02/03 + x)
    const publicKey = secp256k1.getPublicKey(pkBytes, true)

    // HASH160: RIPEMD-160(SHA-256(compressed pubkey))
    const pubkeyHash = hash160(publicKey)

    // Encode as bech32 P2WPKH address
    const hrp = this.network === 'mainnet' ? 'bc' : 'tb'
    return encodeBech32Address(hrp, pubkeyHash)
  }

  /**
   * Sign a Bitcoin transaction (SegWit P2WPKH).
   *
   * The transaction data is expected in the UnsignedTx format with
   * UTXO inputs/outputs provided in `extra.inputs` and `extra.outputs`.
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    const publicKey = secp256k1.getPublicKey(pkBytes, true)
    const pubkeyHash = hash160(publicKey)

    const inputs = (tx.extra?.inputs as Array<{ txHash: string; outputIndex: number; value: string; script?: string }>) ?? []
    const outputs = (tx.extra?.outputs as Array<{ address: string; value: string }>) ?? []

    if (inputs.length === 0) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'Transaction must have at least one input')
    }
    if (outputs.length === 0) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'Transaction must have at least one output')
    }

    // BIP143 SegWit signing for P2WPKH
    const version = writeUint32LE(2) // version 2
    const locktime = writeUint32LE(0)

    // hashPrevouts: double SHA-256 of all input outpoints
    const prevoutsData: Uint8Array[] = []
    for (const input of inputs) {
      const txHashBytes = reverseBytes(hexToBytes(stripHexPrefix(input.txHash)))
      prevoutsData.push(txHashBytes)
      prevoutsData.push(writeUint32LE(input.outputIndex))
    }
    const hashPrevouts = doubleSha256(concat(...prevoutsData))

    // hashSequence: double SHA-256 of all input sequences (all 0xffffffff)
    const sequenceData: Uint8Array[] = []
    for (let i = 0; i < inputs.length; i++) {
      sequenceData.push(writeUint32LE(0xffffffff))
    }
    const hashSequence = doubleSha256(concat(...sequenceData))

    // hashOutputs: double SHA-256 of all output amounts + scriptPubKeys
    const outputsData: Uint8Array[] = []
    for (const output of outputs) {
      const valueSatoshi = BigInt(output.value)
      outputsData.push(writeUint64LE(valueSatoshi))

      // Create scriptPubKey for the output address
      const scriptPubKey = this.addressToScriptPubKey(output.address)
      outputsData.push(encodeVarInt(scriptPubKey.length))
      outputsData.push(scriptPubKey)
    }
    const hashOutputs = doubleSha256(concat(...outputsData))

    // Sign each input
    const witnesses: Uint8Array[][] = []

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]
      const txHashBytes = reverseBytes(hexToBytes(stripHexPrefix(input.txHash)))
      const outpoint = concat(txHashBytes, writeUint32LE(input.outputIndex))

      // scriptCode for P2WPKH: OP_DUP OP_HASH160 <20-byte pubkey hash> OP_EQUALVERIFY OP_CHECKSIG
      const scriptCode = concat(
        new Uint8Array([0x19, 0x76, 0xa9, 0x14]),
        pubkeyHash,
        new Uint8Array([0x88, 0xac]),
      )

      const valueSatoshi = BigInt(input.value)
      const sequence = writeUint32LE(0xffffffff)

      // BIP143 sighash preimage
      const preimage = concat(
        version,
        hashPrevouts,
        hashSequence,
        outpoint,
        scriptCode,
        writeUint64LE(valueSatoshi),
        sequence,
        hashOutputs,
        locktime,
        writeUint32LE(1), // SIGHASH_ALL
      )

      const sigHash = doubleSha256(preimage)
      const signature = secp256k1.sign(sigHash, pkBytes).normalizeS()

      // DER-encode the signature manually
      const derSig = derEncodeSignature(signature.r, signature.s)
      // Append SIGHASH_ALL byte
      const sigWithHashType = concat(derSig, new Uint8Array([0x01]))

      witnesses.push([sigWithHashType, publicKey])
    }

    // Serialize the signed transaction (SegWit format)
    const txParts: Uint8Array[] = []

    // Version
    txParts.push(version)

    // SegWit marker and flag
    txParts.push(new Uint8Array([0x00, 0x01]))

    // Input count
    txParts.push(encodeVarInt(inputs.length))

    // Inputs
    for (const input of inputs) {
      const txHashBytes = reverseBytes(hexToBytes(stripHexPrefix(input.txHash)))
      txParts.push(txHashBytes)
      txParts.push(writeUint32LE(input.outputIndex))
      // Empty scriptSig for SegWit
      txParts.push(new Uint8Array([0x00]))
      txParts.push(writeUint32LE(0xffffffff))
    }

    // Output count
    txParts.push(encodeVarInt(outputs.length))

    // Outputs
    for (const output of outputs) {
      const valueSatoshi = BigInt(output.value)
      txParts.push(writeUint64LE(valueSatoshi))

      const scriptPubKey = this.addressToScriptPubKey(output.address)
      txParts.push(encodeVarInt(scriptPubKey.length))
      txParts.push(scriptPubKey)
    }

    // Witnesses
    for (const witness of witnesses) {
      txParts.push(encodeVarInt(witness.length))
      for (const item of witness) {
        txParts.push(encodeVarInt(item.length))
        txParts.push(item)
      }
    }

    // Locktime
    txParts.push(locktime)

    const rawTx = concat(...txParts)
    return addHexPrefix(bytesToHex(rawTx))
  }

  /**
   * Validate a Bitcoin address.
   * Supports bech32 (bc1/tb1) and legacy base58check (1/3/m/n) formats.
   */
  validateAddress(address: string): boolean {
    try {
      if (address.startsWith('bc1') || address.startsWith('tb1')) {
        const hrp = address.startsWith('bc1') ? 'bc' : 'tb'
        const decoded = bech32.decodeUnsafe(address)
        if (!decoded || decoded.prefix !== hrp) return false
        const witnessProgram = bech32.fromWords(decoded.words.slice(1))
        return witnessProgram.length === 20 || witnessProgram.length === 32
      }
      if (address.startsWith('1') || address.startsWith('3') ||
          address.startsWith('m') || address.startsWith('n')) {
        base58CheckDecode(address)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * Sign an arbitrary message using Bitcoin message signing.
   * Prepends the standard Bitcoin Signed Message prefix.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    // Convert message to bytes
    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Bitcoin message prefix
    const prefix = new TextEncoder().encode('\x18Bitcoin Signed Message:\n')
    const msgLenVarInt = encodeVarInt(msgBytes.length)

    const prefixedMsg = concat(prefix, msgLenVarInt, msgBytes)

    // Double SHA-256 hash
    const msgHash = doubleSha256(prefixedMsg)

    // Sign
    const signature = secp256k1.sign(msgHash, pkBytes)

    // Encode as compact signature: recovery flag (1 byte) + r (32 bytes) + s (32 bytes)
    // Recovery flag for compressed key: 31 + recovery
    const recoveryFlag = 31 + signature.recovery
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')

    return addHexPrefix(
      recoveryFlag.toString(16).padStart(2, '0') + rHex + sHex,
    )
  }

  /**
   * Convert a Bitcoin address to its scriptPubKey.
   */
  private addressToScriptPubKey(address: string): Uint8Array {
    if (address.startsWith('bc1') || address.startsWith('tb1')) {
      // Bech32 P2WPKH address
      const hrp = address.startsWith('bc1') ? 'bc' : 'tb'
      const decoded = bech32.decodeUnsafe(address)
      if (!decoded) {
        throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Failed to decode bech32 address: ${address}`)
      }
      if (decoded.prefix !== hrp) {
        throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Invalid bech32 prefix: ${decoded.prefix}`)
      }
      // First word is witness version, remaining words are the witness program
      const witnessVersion = decoded.words[0]
      const witnessProgram = bech32.fromWords(decoded.words.slice(1))

      if (witnessVersion === 0 && witnessProgram.length === 20) {
        // P2WPKH
        return createP2WPKHScriptPubKey(new Uint8Array(witnessProgram))
      }

      throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Unsupported witness program length: ${witnessProgram.length}`)
    }

    if (address.startsWith('1') || address.startsWith('m') || address.startsWith('n')) {
      // P2PKH - legacy address (base58check decoded)
      // For simplicity, decode the base58check to get the pubkey hash
      const decoded = base58CheckDecode(address)
      // OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG
      return concat(
        new Uint8Array([0x76, 0xa9, 0x14]),
        decoded.data,
        new Uint8Array([0x88, 0xac]),
      )
    }

    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Unsupported address format: ${address}`)
  }
}

// Base58 alphabet used by Bitcoin
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * Decode a Base58Check encoded string.
 * Returns the version byte and the data payload.
 */
function base58CheckDecode(encoded: string): { version: number; data: Uint8Array } {
  // Decode base58
  let num = 0n
  for (const char of encoded) {
    const index = BASE58_ALPHABET.indexOf(char)
    if (index === -1) {
      throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Invalid base58 character: ${char}`)
    }
    num = num * 58n + BigInt(index)
  }

  // Convert to bytes
  let hex = num.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex

  // Count leading '1's for leading zero bytes
  let leadingZeros = 0
  for (const char of encoded) {
    if (char === '1') leadingZeros++
    else break
  }

  const bytes = new Uint8Array(leadingZeros + hex.length / 2)
  for (let i = 0; i < hex.length / 2; i++) {
    bytes[leadingZeros + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }

  // Verify checksum (last 4 bytes)
  const payload = bytes.slice(0, bytes.length - 4)
  const checksum = bytes.slice(bytes.length - 4)
  const hash = doubleSha256(payload)
  for (let i = 0; i < 4; i++) {
    if (hash[i] !== checksum[i]) {
      throw new ChainKitError(ErrorCode.INVALID_ADDRESS, 'Invalid base58check checksum')
    }
  }

  return {
    version: payload[0],
    data: payload.slice(1),
  }
}
