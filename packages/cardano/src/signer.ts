import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import type { CardanoTransactionData } from './types.js'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { hmac } from '@noble/hashes/hmac'
import { blake2b } from '@noble/hashes/blake2b'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { bech32 } from '@scure/base'

// @noble/ed25519 v2 requires setting the sha512 hash function
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

// ---------------------------------------------------------------------------
// Minimal CBOR encoder (RFC 7049) -- no external dependencies
// Exported for testing; these are not part of the public API contract.
// ---------------------------------------------------------------------------

/**
 * Concatenate multiple Uint8Arrays into one.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0
  for (const arr of arrays) totalLength += arr.length
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/**
 * Encode a CBOR header (major type + argument).
 * Major type occupies the top 3 bits of the initial byte.
 */
export function cborEncodeHeader(majorType: number, value: number | bigint): Uint8Array {
  const mt = majorType << 5
  const v = typeof value === 'bigint' ? value : BigInt(value)

  if (v < 24n) {
    return new Uint8Array([mt | Number(v)])
  }
  if (v < 256n) {
    return new Uint8Array([mt | 24, Number(v)])
  }
  if (v < 65536n) {
    return new Uint8Array([mt | 25, Number(v >> 8n) & 0xff, Number(v) & 0xff])
  }
  if (v < 4294967296n) {
    return new Uint8Array([
      mt | 26,
      Number(v >> 24n) & 0xff,
      Number(v >> 16n) & 0xff,
      Number(v >> 8n) & 0xff,
      Number(v) & 0xff,
    ])
  }
  // uint64
  return new Uint8Array([
    mt | 27,
    Number(v >> 56n) & 0xff,
    Number(v >> 48n) & 0xff,
    Number(v >> 40n) & 0xff,
    Number(v >> 32n) & 0xff,
    Number(v >> 24n) & 0xff,
    Number(v >> 16n) & 0xff,
    Number(v >> 8n) & 0xff,
    Number(v) & 0xff,
  ])
}

/**
 * Encode an unsigned integer (major type 0).
 */
export function cborEncodeUint(value: number | bigint): Uint8Array {
  return cborEncodeHeader(0, value)
}

/**
 * Encode a byte string (major type 2).
 */
export function cborEncodeBytes(data: Uint8Array): Uint8Array {
  return concatBytes(cborEncodeHeader(2, data.length), data)
}

/**
 * Encode a CBOR array (major type 4).
 */
export function cborEncodeArray(items: Uint8Array[]): Uint8Array {
  return concatBytes(cborEncodeHeader(4, items.length), ...items)
}

/**
 * Encode a CBOR map (major type 5).
 * Entries are [key, value] pairs, both already CBOR-encoded.
 */
export function cborEncodeMap(entries: [Uint8Array, Uint8Array][]): Uint8Array {
  const flatEntries: Uint8Array[] = []
  for (const [k, v] of entries) {
    flatEntries.push(k, v)
  }
  return concatBytes(cborEncodeHeader(5, entries.length), ...flatEntries)
}

/**
 * Encode CBOR boolean true (0xf5).
 */
export function cborEncodeTrue(): Uint8Array {
  return new Uint8Array([0xf5])
}

/**
 * Encode CBOR null (0xf6).
 */
export function cborEncodeNull(): Uint8Array {
  return new Uint8Array([0xf6])
}

// ---------------------------------------------------------------------------
// Cardano transaction CBOR serialization (Shelley era)
// ---------------------------------------------------------------------------

/**
 * Decode a bech32 Cardano address to its raw bytes.
 */
function decodeAddress(addr: string): Uint8Array {
  const decoded = bech32.decode(addr as `${string}1${string}`, 1023)
  return bech32.fromWords(decoded.words)
}

/**
 * CBOR-encode a Shelley-era TransactionBody as a map:
 *   {
 *     0: [[txHash(32 bytes), outputIndex], ...],  // inputs
 *     1: [[address(bytes), amount(uint)], ...],    // outputs
 *     2: fee (uint),                               // fee in lovelace
 *     3: ttl (uint),                               // slot number
 *   }
 */
export function encodeTransactionBody(txData: CardanoTransactionData): Uint8Array {
  // Encode inputs: set of [tx_hash, output_index]
  const encodedInputs = txData.inputs.map((input) => {
    const txHashBytes = hexToBytes(stripHexPrefix(input.txHash))
    return cborEncodeArray([cborEncodeBytes(txHashBytes), cborEncodeUint(input.outputIndex)])
  })
  const inputsArray = cborEncodeArray(encodedInputs)

  // Encode outputs: [[address_bytes, amount], ...]
  const encodedOutputs = txData.outputs.map((output) => {
    const addrBytes = decodeAddress(output.address)
    return cborEncodeArray([cborEncodeBytes(addrBytes), cborEncodeUint(BigInt(output.amount))])
  })
  const outputsArray = cborEncodeArray(encodedOutputs)

  // Fee
  const fee = cborEncodeUint(BigInt(txData.fee))

  // TTL
  const ttl = cborEncodeUint(txData.ttl)

  // Build the map with integer keys 0-3
  return cborEncodeMap([
    [cborEncodeUint(0), inputsArray],
    [cborEncodeUint(1), outputsArray],
    [cborEncodeUint(2), fee],
    [cborEncodeUint(3), ttl],
  ])
}

/**
 * CBOR-encode a TransactionWitnessSet:
 *   { 0: [[vkey(32 bytes), signature(64 bytes)]] }
 */
export function encodeWitnessSet(publicKey: Uint8Array, signature: Uint8Array): Uint8Array {
  const vkeyWitness = cborEncodeArray([cborEncodeBytes(publicKey), cborEncodeBytes(signature)])
  const witnessArray = cborEncodeArray([vkeyWitness])
  return cborEncodeMap([[cborEncodeUint(0), witnessArray]])
}

/**
 * Build and CBOR-encode a full Shelley transaction:
 *   [transaction_body, witness_set, true, null]
 */
export function encodeFullTransaction(
  txBodyCbor: Uint8Array,
  witnessSetCbor: Uint8Array,
): Uint8Array {
  return cborEncodeArray([txBodyCbor, witnessSetCbor, cborEncodeTrue(), cborEncodeNull()])
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
 * BIP44-style path regex.
 */
const BIP44_PATH_REGEX = /^m(\/\d+'?)+$/

/**
 * SLIP-0010 ED25519 master key derivation from seed.
 * Uses "ed25519 seed" as the HMAC key per SLIP-0010 spec.
 */
function slip0010MasterKey(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed)
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32),
  }
}

/**
 * SLIP-0010 ED25519 child key derivation (hardened only).
 * ED25519 only supports hardened derivation per SLIP-0010.
 */
function slip0010DeriveChild(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  const data = new Uint8Array(1 + 32 + 4)
  data[0] = 0x00
  data.set(parentKey, 1)
  data[33] = (index >>> 24) & 0xff
  data[34] = (index >>> 16) & 0xff
  data[35] = (index >>> 8) & 0xff
  data[36] = index & 0xff

  const I = hmac(sha512, parentChainCode, data)
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32),
  }
}

/**
 * Derive an ED25519 private key from a seed using SLIP-0010.
 * For Cardano CIP-1852: m/1852'/1815'/0'/0/0
 * Note: SLIP-0010 ED25519 requires all path segments to be hardened.
 * Non-hardened segments at the end are treated as hardened internally.
 */
function slip0010DerivePath(seed: Uint8Array, path: string): Uint8Array {
  if (!BIP44_PATH_REGEX.test(path)) {
    throw new ChainKitError(
      ErrorCode.INVALID_PATH,
      `Invalid derivation path: "${path}". Expected format: m/1852'/1815'/0'/0/0`,
    )
  }

  const segments = path.split('/').slice(1) // Remove "m"
  let { key, chainCode } = slip0010MasterKey(seed)

  for (const segment of segments) {
    const hardened = segment.endsWith("'")
    const indexStr = hardened ? segment.slice(0, -1) : segment
    const index = parseInt(indexStr, 10)

    if (isNaN(index)) {
      throw new ChainKitError(ErrorCode.INVALID_PATH, `Invalid path segment: ${segment}`)
    }

    // SLIP-0010 ED25519: force hardened derivation for all segments
    const childIndex = index + 0x80000000

    const child = slip0010DeriveChild(key, chainCode, childIndex)
    key = child.key
    chainCode = child.chainCode
  }

  return key
}

/**
 * Generate a Shelley-era bech32 address from an ED25519 public key.
 *
 * Constructs a type-0 (base address with key-key) enterprise-style address:
 * - Header byte: 0x61 (type 6 enterprise address, mainnet)
 * - Payload: 28-byte blake2b-224 hash of the public key
 *
 * Uses enterprise address (type 6) for simplicity (no staking key).
 * Prefix: "addr" for mainnet.
 */
function publicKeyToShelleyAddress(publicKey: Uint8Array): string {
  // blake2b-224 (28 bytes) hash of the public key
  const keyHash = blake2b(publicKey, { dkLen: 28 })

  // Header byte: 0x61 = type 6 (enterprise) + network 1 (mainnet)
  const payload = new Uint8Array(1 + 28)
  payload[0] = 0x61
  payload.set(keyHash, 1)

  // Encode as bech32 with "addr" prefix
  const words = bech32.toWords(payload)
  return bech32.encode('addr', words, 1023)
}

/**
 * Cardano signer implementing the ChainSigner interface.
 * Uses ED25519 keys with SLIP-0010 derivation and bech32 Shelley addresses.
 *
 * Default HD path: m/1852'/1815'/0'/0/0 (CIP-1852)
 */
export class CardanoSigner implements ChainSigner {
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
   * Derive an ED25519 private key from a mnemonic using SLIP-0010.
   * Default path for Cardano: m/1852'/1815'/0'/0/0 (CIP-1852).
   * Returns a '0x'-prefixed hex string of the 32-byte private key.
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKey = slip0010DerivePath(seed, path)
    return addHexPrefix(bytesToHex(privateKey))
  }

  /**
   * Get the Cardano Shelley address (bech32 "addr1...") for a given private key.
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

    return publicKeyToShelleyAddress(publicKey)
  }

  /**
   * Sign a Cardano transaction.
   *
   * Accepts either structured Cardano transaction data (via tx.extra.cardano)
   * or a pre-computed body hash (via tx.data) for backward compatibility.
   *
   * When structured data is provided:
   * 1. CBOR-encodes the TransactionBody
   * 2. blake2b-256 hashes the CBOR bytes
   * 3. ED25519 signs the hash
   * 4. Assembles the full Transaction with witness set
   * 5. Returns the CBOR-encoded transaction as hex
   *
   * When only tx.data is provided (legacy mode):
   * Signs the provided hash and returns just the signature.
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

    const publicKey = ed25519.getPublicKey(pkBytes)

    // Structured Cardano transaction data path
    const cardanoData = tx.extra?.cardano as CardanoTransactionData | undefined
    if (cardanoData) {
      if (!cardanoData.inputs || cardanoData.inputs.length === 0) {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'Transaction must have at least one input',
        )
      }
      if (!cardanoData.outputs || cardanoData.outputs.length === 0) {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'Transaction must have at least one output',
        )
      }

      // 1. CBOR encode the transaction body
      const txBodyCbor = encodeTransactionBody(cardanoData)

      // 2. blake2b-256 hash of the CBOR bytes
      const txBodyHash = blake2b(txBodyCbor, { dkLen: 32 })

      // 3. ED25519 sign the hash
      const signature = ed25519.sign(txBodyHash, pkBytes)

      // 4. Build witness set
      const witnessSetCbor = encodeWitnessSet(publicKey, signature)

      // 5. Assemble and return full serialized transaction
      const fullTxCbor = encodeFullTransaction(txBodyCbor, witnessSetCbor)
      return addHexPrefix(bytesToHex(fullTxCbor))
    }

    // Legacy mode: sign a pre-computed hash from tx.data
    if (!tx.data) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Transaction data is required: provide either extra.cardano (structured) or data (body hash hex)',
      )
    }

    const messageBytes = hexToBytes(stripHexPrefix(tx.data))

    // If the data is not already a 32-byte hash, hash it with blake2b-256
    const hashToSign = messageBytes.length === 32
      ? messageBytes
      : blake2b(messageBytes, { dkLen: 32 })

    // Sign with ED25519
    const signature = ed25519.sign(hashToSign, pkBytes)

    return addHexPrefix(bytesToHex(signature))
  }

  /**
   * Sign an arbitrary message with ED25519.
   * Returns the 64-byte signature as a hex string.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    const signature = ed25519.sign(msgBytes, pkBytes)

    return addHexPrefix(bytesToHex(signature))
  }
}
