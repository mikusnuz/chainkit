import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx } from '@chainkit/core'
import { blake2b } from '@noble/hashes/blake2b'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
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
 * Compute Blake2b-256 hash of data.
 */
function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 })
}

/**
 * Encode a public key hash as a Kaspa bech32 address.
 * Kaspa uses bech32 encoding with `kaspa` or `kaspatest` prefix.
 * Format: `kaspa:` + bech32(version_byte + pubkey_hash)
 *
 * Kaspa address payload: 1-byte version (0x00 for P2PK-ECDSA, 0x01 for P2SH) + 32-byte pubkey hash
 * But the standard schnorr pubkey address uses the compressed pubkey blake2b hash directly.
 * For ECDSA: version byte 0x01, followed by blake2b-256 of the compressed public key (33 bytes).
 */
function encodeKaspaAddress(prefix: string, pubkeyHash: Uint8Array, version: number = 0x01): string {
  // Kaspa address payload: version byte + hash
  const payload = concat(new Uint8Array([version]), pubkeyHash)
  const words = bech32.toWords(payload)
  return bech32.encode(prefix, words)
}

/**
 * Decode a Kaspa bech32 address to get the pubkey hash.
 */
function decodeKaspaAddress(address: string): { prefix: string; version: number; hash: Uint8Array } {
  // Kaspa addresses use `kaspa:` prefix with bech32
  const decoded = bech32.decodeUnsafe(address)
  if (!decoded) {
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Failed to decode Kaspa address: ${address}`)
  }

  const data = bech32.fromWords(decoded.words)
  if (data.length < 1) {
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Invalid Kaspa address payload: ${address}`)
  }

  return {
    prefix: decoded.prefix,
    version: data[0],
    hash: new Uint8Array(data.slice(1)),
  }
}

/**
 * Write a 64-bit little-endian unsigned integer to a Uint8Array.
 */
function writeUint64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    buf[i] = Number((value >> BigInt(i * 8)) & 0xffn)
  }
  return buf
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
 * Encode a variable-length integer.
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
 * Kaspa signer implementing the ChainSigner interface.
 * Uses secp256k1 for key management with blake2b-256 hashing.
 * Produces bech32 addresses with the `kaspa:` prefix.
 */
export class KaspaSigner implements ChainSigner {
  private readonly network: 'mainnet' | 'testnet'

  constructor(network: 'mainnet' | 'testnet' = 'mainnet') {
    this.network = network
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
   * Derive a private key from a mnemonic using the Kaspa HD path.
   * Default path: m/44'/111111'/0'/0/0
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return addHexPrefix(privateKeyHex)
  }

  /**
   * Get the Kaspa address for a given private key.
   * Process: compressed secp256k1 pubkey -> blake2b-256 -> bech32 with `kaspa:` prefix
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

    // Blake2b-256 hash of the compressed public key
    const pubkeyHash = blake2b256(publicKey)

    // Encode as bech32 with kaspa/kaspatest prefix
    // Version byte 0x01 = ECDSA P2PK
    const prefix = this.network === 'mainnet' ? 'kaspa' : 'kaspatest'
    return encodeKaspaAddress(prefix, pubkeyHash, 0x01)
  }

  /**
   * Sign a Kaspa transaction.
   *
   * Kaspa uses a UTXO model similar to Bitcoin but with blake2b hashing
   * and operates on a blockDAG rather than a blockchain.
   *
   * Inputs/outputs are provided via `extra.inputs` and `extra.outputs`.
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    const publicKey = secp256k1.getPublicKey(pkBytes, true)
    const pubkeyHash = blake2b256(publicKey)

    const inputs = (tx.extra?.inputs as Array<{ txHash: string; outputIndex: number; value: string; script?: string }>) ?? []
    const outputs = (tx.extra?.outputs as Array<{ address: string; value: string }>) ?? []

    if (inputs.length === 0) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'Transaction must have at least one input')
    }
    if (outputs.length === 0) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'Transaction must have at least one output')
    }

    // Kaspa transaction serialization
    // Version
    const version = writeUint32LE(0)

    // Serialize inputs
    const inputParts: Uint8Array[] = []
    inputParts.push(encodeVarInt(inputs.length))
    for (const input of inputs) {
      const txHashBytes = reverseBytes(hexToBytes(stripHexPrefix(input.txHash)))
      inputParts.push(txHashBytes)
      inputParts.push(writeUint32LE(input.outputIndex))
      // Empty sigScript placeholder (will be filled with signatures)
      inputParts.push(encodeVarInt(0))
      inputParts.push(writeUint64LE(BigInt(input.value)))
      inputParts.push(writeUint32LE(0)) // sequence
    }

    // Serialize outputs
    const outputParts: Uint8Array[] = []
    outputParts.push(encodeVarInt(outputs.length))
    for (const output of outputs) {
      outputParts.push(writeUint64LE(BigInt(output.value)))
      // Script pubkey: version + pubkey hash from address
      const decoded = decodeKaspaAddress(output.address)
      const scriptPubKey = concat(new Uint8Array([decoded.version]), decoded.hash)
      outputParts.push(encodeVarInt(scriptPubKey.length))
      outputParts.push(scriptPubKey)
    }

    // Locktime
    const locktime = writeUint64LE(0n)
    // SubnetworkID (20 bytes of zeros for native transactions)
    const subnetworkId = new Uint8Array(20)

    // Hash the outputs for the sighash
    const outputsBlob = concat(...outputParts)
    const hashOutputs = blake2b256(outputsBlob)

    // Sign each input
    const signatures: Uint8Array[] = []
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]
      const txHashBytes = reverseBytes(hexToBytes(stripHexPrefix(input.txHash)))
      const outpoint = concat(txHashBytes, writeUint32LE(input.outputIndex))

      // SigHash preimage: version + prevout + value + sequence + outputs hash + locktime + subnetwork
      const scriptPubKey = concat(new Uint8Array([0x01]), pubkeyHash)
      const preimage = concat(
        version,
        outpoint,
        encodeVarInt(scriptPubKey.length),
        scriptPubKey,
        writeUint64LE(BigInt(input.value)),
        writeUint32LE(0), // sequence
        hashOutputs,
        locktime,
        subnetworkId,
        writeUint32LE(1), // SIGHASH_ALL
      )

      const sigHash = blake2b256(preimage)
      const signature = secp256k1.sign(sigHash, pkBytes)
      const sigBytes = signature.toCompactRawBytes()
      signatures.push(sigBytes)
    }

    // Assemble the signed transaction
    const txParts: Uint8Array[] = []
    txParts.push(version)

    // Inputs with signatures
    txParts.push(encodeVarInt(inputs.length))
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]
      const txHashBytes = reverseBytes(hexToBytes(stripHexPrefix(input.txHash)))
      txParts.push(txHashBytes)
      txParts.push(writeUint32LE(input.outputIndex))

      // SigScript: signature + compressed pubkey
      const sigScript = concat(
        encodeVarInt(signatures[i].length),
        signatures[i],
        encodeVarInt(publicKey.length),
        publicKey,
      )
      txParts.push(encodeVarInt(sigScript.length))
      txParts.push(sigScript)
      txParts.push(writeUint64LE(BigInt(input.value)))
      txParts.push(writeUint32LE(0)) // sequence
    }

    // Outputs
    txParts.push(encodeVarInt(outputs.length))
    for (const output of outputs) {
      txParts.push(writeUint64LE(BigInt(output.value)))
      const decoded = decodeKaspaAddress(output.address)
      const scriptPubKey = concat(new Uint8Array([decoded.version]), decoded.hash)
      txParts.push(encodeVarInt(scriptPubKey.length))
      txParts.push(scriptPubKey)
    }

    // Locktime + subnetwork
    txParts.push(locktime)
    txParts.push(subnetworkId)

    const rawTx = concat(...txParts)
    return addHexPrefix(bytesToHex(rawTx))
  }

  /**
   * Sign an arbitrary message using Kaspa message signing.
   * Hash: blake2b-256 of the prefixed message.
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Kaspa message prefix
    const prefix = new TextEncoder().encode('\x18Kaspa Signed Message:\n')
    const msgLenVarInt = encodeVarInt(msgBytes.length)

    const prefixedMsg = concat(prefix, msgLenVarInt, msgBytes)

    // Blake2b-256 hash
    const msgHash = blake2b256(prefixedMsg)

    // Sign
    const signature = secp256k1.sign(msgHash, pkBytes)

    // Compact signature: recovery flag (1 byte) + r (32 bytes) + s (32 bytes)
    const recoveryFlag = 31 + signature.recovery
    const rHex = signature.r.toString(16).padStart(64, '0')
    const sHex = signature.s.toString(16).padStart(64, '0')

    return addHexPrefix(
      recoveryFlag.toString(16).padStart(2, '0') + rHex + sHex,
    )
  }
}
