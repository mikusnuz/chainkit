import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import { weierstrass } from '@noble/curves/abstract/weierstrass'
import { Field } from '@noble/curves/abstract/modular'
import { sha256 } from '@noble/hashes/sha256'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

/**
 * StarkNet curve parameters (a Weierstrass curve over a prime field).
 *
 * Curve equation: y^2 = x^3 + alpha*x + beta (mod P)
 * This is the STARK-friendly curve used for ECDSA in StarkNet.
 */
const STARK_P = BigInt(
  '0x0800000000000011000000000000000000000000000000000000000000000001',
)
const STARK_N = BigInt(
  '0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2f',
)
const STARK_Gx = BigInt(
  '0x01ef15c18599971b7beced415a40f0c7deacfd9b0d1819e03d723d8bc943cfca',
)
const STARK_Gy = BigInt(
  '0x005668060aa49730b7be4801df46ec62de53ecd11abe43a32873000c36e8dc1f',
)
const STARK_ALPHA = BigInt(1)
const STARK_BETA = BigInt(
  '0x06f21413efbe40de150e596d72f7a8c5609ad26c15c915c1f4cdfcb99cee9e89',
)

/**
 * The Stark curve instance built from @noble/curves abstract weierstrass.
 */
const starkCurve = weierstrass({
  a: STARK_ALPHA,
  b: STARK_BETA,
  Fp: Field(STARK_P),
  n: STARK_N,
  Gx: STARK_Gx,
  Gy: STARK_Gy,
  h: BigInt(1),
  hash: sha256,
  hmac: (k: Uint8Array, ...m: Uint8Array[]) => {
    const concat = new Uint8Array(m.reduce((s, a) => s + a.length, 0))
    let offset = 0
    for (const arr of m) {
      concat.set(arr, offset)
      offset += arr.length
    }
    return hmac(sha256, k, concat)
  },
})

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
 * Reduce a 32-byte key into the Stark curve order.
 *
 * BIP32 derives a secp256k1-range key. We take it modulo STARK_N
 * to produce a valid Stark private key, skipping zero.
 */
function grindKey(seed256: Uint8Array): Uint8Array {
  const seedBigInt = BigInt('0x' + bytesToHex(seed256))
  let key = seedBigInt % STARK_N
  if (key === 0n) {
    key = 1n
  }
  let hex = key.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  // Pad to 32 bytes
  hex = hex.padStart(64, '0')
  return hexToBytes(hex)
}

/**
 * Compute a simplified StarkNet contract address.
 *
 * In production StarkNet, addresses are derived from:
 *   pedersen(prefix, deployerAddress, salt, classHash, constructorCalldataHash)
 *
 * For SDK purposes we use a simplified derivation:
 *   sha256(starkPublicKeyX) truncated to the Stark field.
 */
function computeAddress(publicKeyX: bigint): string {
  let xHex = publicKeyX.toString(16).padStart(64, '0')
  const xBytes = hexToBytes(xHex)
  const hash = sha256(xBytes)
  const addrBigInt = BigInt('0x' + bytesToHex(hash)) % STARK_P
  return '0x' + addrBigInt.toString(16).padStart(64, '0')
}

/**
 * StarkNet signer implementing the ChainSigner interface.
 *
 * Key derivation:
 * 1. BIP39 mnemonic -> seed
 * 2. BIP32 derivation at m/44'/9004'/0'/0/0 (secp256k1 HD tree)
 * 3. Resulting 32-byte key is "ground" into the Stark curve order
 * 4. Stark ECDSA signing uses the stark curve
 *
 * Address derivation:
 * - Simplified: sha256(pubkey_x) mod STARK_P, formatted as 0x + 64-char hex
 */
export class StarknetSigner implements ChainSigner {
  constructor(_network?: 'mainnet' | 'testnet') {}

  getDefaultHdPath(): string {
    return "m/44'/9004'/0'/0/0"
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
   * Derive a Stark private key from a mnemonic.
   *
   * Steps:
   * 1. Derive a secp256k1 key via standard BIP32 at the given path
   * 2. Grind the key into the Stark curve order
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const secp256k1Hex = derivePath(seed, path)
    const secp256k1Bytes = hexToBytes(secp256k1Hex)
    const starkKey = grindKey(secp256k1Bytes)
    return addHexPrefix(bytesToHex(starkKey))
  }

  /**
   * Get the StarkNet address for a given private key.
   * Returns a 0x-prefixed 64-char hex string.
   */
  getAddress(privateKey: HexString): Address {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get the public key on the Stark curve
    const publicKeyBytes = starkCurve.getPublicKey(pkBytes, false)

    // Parse uncompressed public key (04 + x + y), each coordinate 32 bytes
    const xBytes = publicKeyBytes.slice(1, 33)
    const pubKeyX = BigInt('0x' + bytesToHex(xBytes))

    return computeAddress(pubKeyX)
  }

  /**
   * Sign a StarkNet transaction.
   *
   * The transaction data (tx.data) should contain the hex-encoded message hash
   * to be signed. The signature is returned as r (32 bytes) + s (32 bytes).
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (!tx.data) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Transaction data (serialized message hash) is required for StarkNet signing',
      )
    }

    // The data field contains the hash to sign
    const msgHash = hexToBytes(stripHexPrefix(tx.data as string))

    const signature = starkCurve.sign(msgHash, pkBytes, { prehash: false, lowS: false })
    const sigBytes = signature.toCompactRawBytes()

    return addHexPrefix(bytesToHex(sigBytes))
  }

  /**
   * Validate a StarkNet address.
   * StarkNet addresses are 0x-prefixed hex strings of up to 64 characters (32 bytes).
   */
  validateAddress(address: string): boolean {
    try {
      if (!address.startsWith('0x')) return false
      const hex = address.slice(2)
      if (hex.length === 0 || hex.length > 64) return false
      return /^[0-9a-fA-F]+$/.test(hex)
    } catch {
      return false
    }
  }

  /**
   * Sign an arbitrary message using Stark ECDSA.
   *
   * The message is hashed with SHA-256 before signing (since the Stark curve
   * uses SHA-256 as its hash function).
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Hash the message with SHA-256 (configured as the curve hash)
    const msgHash = sha256(msgBytes)

    const signature = starkCurve.sign(msgHash, pkBytes, { prehash: false, lowS: false })
    const sigBytes = signature.toCompactRawBytes()

    return addHexPrefix(bytesToHex(sigBytes))
  }
}

/**
 * Verify a Stark ECDSA signature.
 * Exported as a utility for consumers.
 */
export function verifyStarkSignature(
  msgHash: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return starkCurve.verify(signature, msgHash, publicKey)
}

/**
 * Get the Stark public key from a private key.
 * Returns the uncompressed public key bytes (65 bytes: 04 + x + y).
 */
export function getStarkPublicKey(privateKey: Uint8Array): Uint8Array {
  return starkCurve.getPublicKey(privateKey, false)
}

/**
 * Exported Stark curve constants for advanced usage.
 */
export const STARK_CURVE = {
  P: STARK_P,
  N: STARK_N,
  Gx: STARK_Gx,
  Gy: STARK_Gy,
  ALPHA: STARK_ALPHA,
  BETA: STARK_BETA,
} as const
