import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { hmac } from '@noble/hashes/hmac'
import { blake2b } from '@noble/hashes/blake2b'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { bech32 } from '@scure/base'
import type { IotaTransactionEssence } from './types.js'

// @noble/ed25519 v2 requires setting the sha512 hash function
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

/** Default IOTA bech32 human-readable part. */
const IOTA_HRP = 'iota'

/** Ed25519 address type byte per IOTA protocol. */
const ED25519_ADDRESS_TYPE = 0x00

/** Stardust protocol constants */
const TRANSACTION_PAYLOAD_TYPE = 6
const REGULAR_ESSENCE_TYPE = 1
const UTXO_INPUT_TYPE = 0
const BASIC_OUTPUT_TYPE = 3
const ADDRESS_UNLOCK_CONDITION_TYPE = 0
const SIGNATURE_UNLOCK_TYPE = 0
const ED25519_SIGNATURE_TYPE = 0

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

// ---- Binary serialization helpers (little-endian) ----

/**
 * Write a single unsigned byte to a buffer.
 */
function writeU8(value: number): Uint8Array {
  const buf = new Uint8Array(1)
  buf[0] = value & 0xff
  return buf
}

/**
 * Write a 16-bit unsigned integer in little-endian format.
 */
function writeU16LE(value: number): Uint8Array {
  const buf = new Uint8Array(2)
  buf[0] = value & 0xff
  buf[1] = (value >>> 8) & 0xff
  return buf
}

/**
 * Write a 32-bit unsigned integer in little-endian format.
 */
function writeU32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  buf[0] = value & 0xff
  buf[1] = (value >>> 8) & 0xff
  buf[2] = (value >>> 16) & 0xff
  buf[3] = (value >>> 24) & 0xff
  return buf
}

/**
 * Write a 64-bit unsigned integer in little-endian format from a bigint.
 */
function writeU64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    buf[i] = Number((value >> BigInt(i * 8)) & 0xffn)
  }
  return buf
}

/**
 * Concatenate multiple Uint8Arrays into a single buffer.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
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

// ---- IOTA Stardust binary serialization ----

/**
 * Serialize a UTXO input in Stardust binary format.
 *
 * Format:
 *   input_type: u8 (0 = UTXO)
 *   transaction_id: 32 bytes
 *   transaction_output_index: u16 LE
 */
function serializeUtxoInput(input: {
  transactionId: string
  transactionOutputIndex: number
}): Uint8Array {
  const txIdBytes = hexToBytes(stripHexPrefix(input.transactionId))
  if (txIdBytes.length !== 32) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid transaction ID length: expected 32 bytes, got ${txIdBytes.length}`,
    )
  }
  return concatBytes(
    writeU8(UTXO_INPUT_TYPE),
    txIdBytes,
    writeU16LE(input.transactionOutputIndex),
  )
}

/**
 * Serialize a BasicOutput in Stardust binary format.
 *
 * Format:
 *   output_type: u8 (3 = BasicOutput)
 *   amount: u64 LE
 *   native_tokens_count: u8 (0)
 *   unlock_conditions_count: u8 (1)
 *   unlock_condition_type: u8 (0 = AddressUnlockCondition)
 *   address_type: u8 (0 = Ed25519)
 *   address_hash: 32 bytes
 *   features_count: u8 (0)
 */
function serializeBasicOutput(output: {
  amount: string
  unlockConditions: Array<{
    type: number
    address: { type: number; pubKeyHash: string }
  }>
}): Uint8Array {
  const amount = BigInt(output.amount)

  if (output.unlockConditions.length === 0) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      'BasicOutput must have at least one unlock condition',
    )
  }

  const addrCondition = output.unlockConditions[0]
  const addressHash = hexToBytes(stripHexPrefix(addrCondition.address.pubKeyHash))
  if (addressHash.length !== 32) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid address hash length: expected 32 bytes, got ${addressHash.length}`,
    )
  }

  return concatBytes(
    writeU8(BASIC_OUTPUT_TYPE),       // output_type
    writeU64LE(amount),               // amount
    writeU8(0),                       // native_tokens_count = 0
    writeU8(1),                       // unlock_conditions_count = 1
    writeU8(ADDRESS_UNLOCK_CONDITION_TYPE), // unlock_condition_type
    writeU8(addrCondition.address.type),    // address_type (0 = Ed25519)
    addressHash,                      // address_hash (32 bytes)
    writeU8(0),                       // features_count = 0
  )
}

/**
 * Compute the inputs commitment: blake2b-256 hash of all serialized output IDs
 * consumed by the inputs.
 *
 * Each output ID = transaction_id (32 bytes) || output_index (u16 LE).
 */
function computeInputsCommitment(
  inputs: Array<{ transactionId: string; transactionOutputIndex: number }>,
): Uint8Array {
  const parts: Uint8Array[] = []
  for (const input of inputs) {
    const txIdBytes = hexToBytes(stripHexPrefix(input.transactionId))
    parts.push(concatBytes(txIdBytes, writeU16LE(input.transactionOutputIndex)))
  }
  const allOutputIds = concatBytes(...parts)
  return blake2b(allOutputIds, { dkLen: 32 })
}

/**
 * Serialize a complete TransactionEssence in Stardust binary format.
 *
 * Format:
 *   essence_type: u8 (1 = regular)
 *   network_id: u64 LE
 *   inputs_count: u16 LE
 *   inputs: [serialized UTXO inputs]
 *   inputs_commitment: 32 bytes (blake2b-256)
 *   outputs_count: u16 LE
 *   outputs: [serialized BasicOutputs]
 *   payload_length: u32 LE (0 = no payload)
 */
export function serializeTransactionEssence(essence: IotaTransactionEssence): Uint8Array {
  const networkId = BigInt(essence.networkId)

  // Serialize inputs
  const serializedInputs: Uint8Array[] = []
  for (const input of essence.inputs) {
    serializedInputs.push(serializeUtxoInput(input))
  }

  // Compute inputs commitment
  const inputsCommitment = computeInputsCommitment(essence.inputs)

  // Serialize outputs
  const serializedOutputs: Uint8Array[] = []
  for (const output of essence.outputs) {
    serializedOutputs.push(serializeBasicOutput(output))
  }

  return concatBytes(
    writeU8(REGULAR_ESSENCE_TYPE),                // essence_type
    writeU64LE(networkId),                         // network_id
    writeU16LE(essence.inputs.length),             // inputs_count
    ...serializedInputs,                           // inputs
    inputsCommitment,                              // inputs_commitment (32 bytes)
    writeU16LE(essence.outputs.length),            // outputs_count
    ...serializedOutputs,                          // outputs
    writeU32LE(0),                                 // payload_length (0 = no nested payload)
  )
}

/**
 * Serialize a signature unlock in Stardust binary format.
 *
 * Format:
 *   unlock_type: u8 (0 = Signature)
 *   signature_type: u8 (0 = Ed25519)
 *   public_key: 32 bytes
 *   signature: 64 bytes
 */
function serializeSignatureUnlock(
  publicKey: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  if (publicKey.length !== 32) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid public key length: expected 32 bytes, got ${publicKey.length}`,
    )
  }
  if (signature.length !== 64) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid signature length: expected 64 bytes, got ${signature.length}`,
    )
  }
  return concatBytes(
    writeU8(SIGNATURE_UNLOCK_TYPE),   // unlock_type
    writeU8(ED25519_SIGNATURE_TYPE),  // signature_type
    publicKey,                        // public_key (32 bytes)
    signature,                        // signature (64 bytes)
  )
}

/**
 * Build a complete TransactionPayload in Stardust binary format.
 *
 * Format:
 *   payload_type: u32 LE (6 = transaction)
 *   essence: serialized TransactionEssence
 *   unlocks_count: u16 LE
 *   unlocks: [serialized unlocks]
 */
export function buildTransactionPayload(
  essence: IotaTransactionEssence,
  publicKey: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  const essenceBytes = serializeTransactionEssence(essence)
  const unlock = serializeSignatureUnlock(publicKey, signature)

  // All inputs use the same key => first unlock is Signature, rest are Reference(0)
  const unlockParts: Uint8Array[] = [unlock]
  for (let i = 1; i < essence.inputs.length; i++) {
    // Reference unlock: type=1, reference_index=u16 LE (0)
    unlockParts.push(concatBytes(writeU8(1), writeU16LE(0)))
  }

  return concatBytes(
    writeU32LE(TRANSACTION_PAYLOAD_TYPE),        // payload_type
    essenceBytes,                                 // transaction essence
    writeU16LE(essence.inputs.length),            // unlocks_count
    ...unlockParts,                               // unlocks
  )
}

/**
 * BIP44 path regex: m / purpose' / coin_type' / account' / change' / index'
 * All segments must be hardened for ED25519 (SLIP-0010).
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
  // Hardened child: HMAC-SHA512(Key = chainCode, Data = 0x00 || parentKey || index)
  const data = new Uint8Array(1 + 32 + 4)
  data[0] = 0x00
  data.set(parentKey, 1)
  // index in big-endian
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
 * All path components must be hardened (indicated by ').
 */
function slip0010DerivePath(seed: Uint8Array, path: string): Uint8Array {
  if (!BIP44_PATH_REGEX.test(path)) {
    throw new ChainKitError(
      ErrorCode.INVALID_PATH,
      `Invalid derivation path: "${path}". Expected format: m/44'/4218'/0'/0'/0'`,
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

    // SLIP-0010 ED25519 only supports hardened derivation
    if (!hardened) {
      throw new ChainKitError(
        ErrorCode.INVALID_PATH,
        `ED25519 (SLIP-0010) only supports hardened derivation. Segment "${segment}" must be hardened (add ').`,
      )
    }

    const childIndex = index + 0x80000000
    const child = slip0010DeriveChild(key, chainCode, childIndex)
    key = child.key
    chainCode = child.chainCode
  }

  return key
}

/**
 * Derive an IOTA bech32 address from an ED25519 public key.
 *
 * Address = bech32(hrp, 0x00 || blake2b-256(pubkey))
 *   - 0x00 is the Ed25519 address type byte
 *   - blake2b-256 produces a 32-byte hash
 *   - Total address data: 33 bytes (1 type byte + 32 hash bytes)
 */
function pubkeyToAddress(publicKey: Uint8Array, hrp: string = IOTA_HRP): Address {
  // blake2b-256 of the public key
  const addressHash = blake2b(publicKey, { dkLen: 32 })

  // Prepend the Ed25519 address type byte (0x00)
  const addressData = new Uint8Array(1 + 32)
  addressData[0] = ED25519_ADDRESS_TYPE
  addressData.set(addressHash, 1)

  // Encode as bech32 with IOTA HRP
  const words = bech32.toWords(addressData)
  return bech32.encode(hrp, words, 90)
}

/**
 * IOTA signer implementing the ChainSigner interface.
 * Uses ED25519 keys with SLIP-0010 derivation and bech32 addresses.
 *
 * Default HD path: m/44'/4218'/0'/0'/0' (IOTA coin type 4218, all hardened per SLIP-0010)
 */
export class IotaSigner implements ChainSigner {
  constructor(_network?: 'mainnet' | 'testnet') {}

  getDefaultHdPath(): string {
    return "m/44'/4218'/0'/0'/0'"
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
   * Derive an ED25519 private key from a mnemonic using SLIP-0010.
   * Returns a '0x'-prefixed hex string of the 32-byte seed (private key).
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKey = slip0010DerivePath(seed, path)
    return addHexPrefix(bytesToHex(privateKey))
  }

  /**
   * Get the IOTA bech32 address for a given private key.
   *
   * The address is derived by:
   * 1. Computing the ED25519 public key from the private key
   * 2. Taking blake2b-256 of the public key
   * 3. Prepending 0x00 (Ed25519 address type)
   * 4. Encoding with bech32 using 'iota' HRP
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

    return pubkeyToAddress(publicKey)
  }

  /**
   * Sign an IOTA transaction with full Stardust binary serialization.
   *
   * Supports two modes:
   * 1. **Structured mode**: Pass a JSON-serialized `IotaTransactionEssence` in `tx.data`.
   *    Returns the full TransactionPayload as a hex string, ready for broadcast.
   * 2. **Raw mode**: Pass raw pre-serialized essence bytes (hex) in `tx.data` with
   *    `tx.fee.mode` set to `"raw"`. Returns just the ED25519 signature.
   *
   * Structured mode flow:
   *   - Parses the `IotaTransactionEssence` from `tx.data`
   *   - Serializes the essence to binary (Stardust format)
   *   - Computes blake2b-256 hash of the essence bytes
   *   - Signs the hash with ED25519
   *   - Builds the complete TransactionPayload with unlocks
   *   - Returns the full payload as a hex string
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

    if (!tx.data) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Transaction data is required for IOTA signing',
      )
    }

    const publicKey = ed25519.getPublicKey(pkBytes)

    // Check if raw mode is requested (backward-compatible: pre-serialized essence bytes)
    if (tx.fee?.mode === 'raw') {
      const essenceBytes = hexToBytes(stripHexPrefix(tx.data as string))
      const essenceHash = blake2b(essenceBytes, { dkLen: 32 })
      const signature = ed25519.sign(essenceHash, pkBytes)
      return addHexPrefix(bytesToHex(signature))
    }

    // Structured mode: parse IotaTransactionEssence from tx.data
    let essence: IotaTransactionEssence
    try {
      essence = JSON.parse(tx.data as string) as IotaTransactionEssence
    } catch {
      // Fallback: treat as raw hex essence bytes (backward compatibility)
      const essenceBytes = hexToBytes(stripHexPrefix(tx.data as string))
      const essenceHash = blake2b(essenceBytes, { dkLen: 32 })
      const signature = ed25519.sign(essenceHash, pkBytes)
      return addHexPrefix(bytesToHex(signature))
    }

    // Validate the parsed essence has required fields
    if (!essence.networkId || !essence.inputs || !essence.outputs) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Invalid transaction essence: networkId, inputs, and outputs are required',
      )
    }

    if (essence.inputs.length === 0) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Transaction must have at least one input',
      )
    }

    if (essence.outputs.length === 0) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Transaction must have at least one output',
      )
    }

    // Serialize the transaction essence to binary
    const essenceBytes = serializeTransactionEssence(essence)

    // Hash the essence with blake2b-256
    const essenceHash = blake2b(essenceBytes, { dkLen: 32 })

    // Sign the hash with ED25519
    const signature = ed25519.sign(essenceHash, pkBytes)

    // Build the complete TransactionPayload
    const payload = buildTransactionPayload(essence, publicKey, signature)

    return addHexPrefix(bytesToHex(payload))
  }

  /**
   * Validate an IOTA bech32 address.
   * IOTA addresses use bech32 encoding with the 'iota' human-readable prefix.
   */
  validateAddress(address: string): boolean {
    try {
      if (!address.startsWith('iota1')) return false
      const decoded = bech32.decodeToBytes(address)
      // Should decode to 33 bytes: 1 type byte + 32 hash bytes
      return decoded.bytes.length === 33
    } catch {
      return false
    }
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
