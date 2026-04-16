/**
 * Poseidon hash implementation for Mina's Pallas field (Kimchi).
 *
 * Mina Protocol uses Poseidon hash for transaction signing.
 * This module implements the Poseidon permutation with the following parameters:
 *
 * - Field: Pallas (p = 28948022309329048855892746252171976963363056481941560715954676764349967630337)
 * - State width: 3
 * - Full rounds: 55
 * - Partial rounds: 0
 * - S-box exponent: 7 (x^7)
 * - MDS matrix: exact 3x3 matrix from o1js (poseidonParamsKimchiFp)
 * - Round constants: exact 165 constants from o1js (poseidonParamsKimchiFp)
 *
 * Reference: https://github.com/o1-labs/o1js/blob/main/src/bindings/crypto/
 */

import {
  PALLAS_MODULUS,
  POSEIDON_FULL_ROUNDS,
  POSEIDON_STATE_WIDTH,
  POSEIDON_ALPHA,
  POSEIDON_MDS,
  POSEIDON_ROUND_CONSTANTS,
  PREFIXES,
} from './poseidon-constants.js'

export { PALLAS_MODULUS }

// ---- Field arithmetic over Pallas ----

function fieldMod(a: bigint): bigint {
  const r = a % PALLAS_MODULUS
  return r < 0n ? r + PALLAS_MODULUS : r
}

function fieldAdd(a: bigint, b: bigint): bigint {
  return fieldMod(a + b)
}

function fieldMul(a: bigint, b: bigint): bigint {
  return fieldMod(a * b)
}

/**
 * Modular exponentiation: base^exp mod PALLAS_MODULUS.
 */
function fieldPow(base: bigint, exp: bigint): bigint {
  if (exp === 0n) return 1n
  let result = 1n
  let b = fieldMod(base)
  let e = exp
  while (e > 0n) {
    if (e & 1n) {
      result = fieldMul(result, b)
    }
    b = fieldMul(b, b)
    e >>= 1n
  }
  return result
}

/**
 * S-box: x -> x^7 in the Pallas field.
 */
function sbox(x: bigint): bigint {
  return fieldPow(x, POSEIDON_ALPHA)
}

/**
 * Apply the MDS matrix to the state.
 */
function mdsMultiply(state: bigint[]): bigint[] {
  const result: bigint[] = [0n, 0n, 0n]
  for (let i = 0; i < POSEIDON_STATE_WIDTH; i++) {
    for (let j = 0; j < POSEIDON_STATE_WIDTH; j++) {
      result[i] = fieldAdd(result[i], fieldMul(POSEIDON_MDS[i][j], state[j]))
    }
  }
  return result
}

/**
 * Poseidon permutation on 3 field elements.
 *
 * For each full round:
 * 1. Apply S-box (x^7) to all state elements
 * 2. Apply MDS matrix
 * 3. Add round constants
 *
 * Note: Mina's Poseidon applies the round constants AFTER the MDS multiply,
 * matching the o1js implementation.
 */
function poseidonPermutation(state: bigint[]): bigint[] {
  let s = [...state]

  for (let round = 0; round < POSEIDON_FULL_ROUNDS; round++) {
    // 1. S-box on all state elements
    for (let i = 0; i < POSEIDON_STATE_WIDTH; i++) {
      s[i] = sbox(s[i])
    }

    // 2. MDS matrix multiplication
    s = mdsMultiply(s)

    // 3. Add round constants
    for (let i = 0; i < POSEIDON_STATE_WIDTH; i++) {
      s[i] = fieldAdd(s[i], POSEIDON_ROUND_CONSTANTS[round][i])
    }
  }

  return s
}

/**
 * Poseidon update (sponge absorption).
 *
 * Absorbs input into the state using rate=2 sponge construction.
 * Input is padded with zeros to a multiple of the rate.
 *
 * @param state - Current sponge state [3 field elements]
 * @param input - Array of field elements to absorb
 * @returns Updated state after absorption
 */
export function poseidonUpdate(state: bigint[], input: bigint[]): bigint[] {
  const rate = 2
  let s = [...state]

  // Special case: empty input still applies one permutation
  // (matches o1js behavior)
  if (input.length === 0) {
    s = poseidonPermutation(s)
    return s
  }

  // Pad input to multiple of rate
  const n = Math.ceil(input.length / rate) * rate
  const padded = [...input]
  while (padded.length < n) {
    padded.push(0n)
  }

  for (let i = 0; i < n; i += rate) {
    for (let j = 0; j < rate; j++) {
      s[j] = fieldAdd(s[j], padded[i + j])
    }
    s = poseidonPermutation(s)
  }

  return s
}

/**
 * Poseidon initial state: all zeros.
 */
export function poseidonInitialState(): bigint[] {
  return [0n, 0n, 0n]
}

/**
 * Poseidon hash function (sponge construction).
 *
 * Uses the sponge construction with:
 * - Rate: 2 (absorb 2 field elements at a time)
 * - Capacity: 1 (1 field element)
 * - Initial state: [0, 0, 0]
 *
 * @param inputs - Array of Pallas field elements to hash
 * @returns A single Pallas field element (the hash)
 */
export function poseidonHash(inputs: bigint[]): bigint {
  const state = poseidonUpdate(poseidonInitialState(), inputs)
  return state[0]
}

/**
 * Convert a prefix string to a Pallas field element.
 *
 * Mina encodes prefixes by converting the string to UTF-8 bytes,
 * zero-padding to 32 bytes, then interpreting as a little-endian integer.
 *
 * This matches the o1js `prefixToField` implementation from
 * src/bindings/lib/binable.ts.
 *
 * @param prefix - Domain separation prefix string (max 31 chars)
 * @returns A single Pallas field element
 */
export function prefixToField(prefix: string): bigint {
  const fieldSizeBytes = 32
  if (prefix.length >= fieldSizeBytes) {
    throw new Error('prefix too long')
  }
  // Convert string to bytes
  const encoder = new TextEncoder()
  const stringBytes = encoder.encode(prefix)
  // Zero-pad to 32 bytes and interpret as little-endian bigint
  let result = 0n
  for (let i = 0; i < stringBytes.length; i++) {
    result += BigInt(stringBytes[i]) << BigInt(8 * i)
  }
  return fieldMod(result)
}

/**
 * Poseidon hash with a prefix string (domain separation).
 *
 * Mina uses prefix-based domain separation for different hash contexts:
 * - "MinaSignatureMainnet" for mainnet transaction signing
 * - "CodaSignature*******" for testnet/devnet transaction signing
 *
 * The algorithm:
 * 1. Convert prefix to a field element
 * 2. Initialize state and absorb the prefix field element (salt)
 * 3. Absorb the actual input into the salted state
 * 4. Return state[0] as the hash
 *
 * This matches o1js: hashWithPrefix(prefix, input) =
 *   update(update(initialState(), [prefixToField(prefix)]), input)[0]
 *
 * @param prefix - Domain separation prefix string
 * @param inputs - Array of Pallas field elements to hash
 * @returns A single Pallas field element (the hash)
 */
export function poseidonHashWithPrefix(prefix: string, inputs: bigint[]): bigint {
  const prefixField = prefixToField(prefix)
  // Salt: absorb prefix into initial state
  const salted = poseidonUpdate(poseidonInitialState(), [prefixField])
  // Then absorb actual input
  const final = poseidonUpdate(salted, inputs)
  return final[0]
}

// ---- Legacy hash input format (for transaction signing) ----

/**
 * Legacy hash input format used by Mina's transaction signing.
 *
 * Contains separate arrays of field elements and boolean bits.
 * Fields are raw Pallas field elements (e.g., public key x-coordinates).
 * Bits are boolean values (e.g., public key y-parity, tag bits, uint bits).
 */
export interface HashInputLegacy {
  fields: bigint[]
  bits: boolean[]
}

export const HashInputLegacyOps = {
  empty(): HashInputLegacy {
    return { fields: [], bits: [] }
  },

  bits(b: boolean[]): HashInputLegacy {
    return { fields: [], bits: b }
  },

  fields(f: bigint[]): HashInputLegacy {
    return { fields: f, bits: [] }
  },

  append(a: HashInputLegacy, b: HashInputLegacy): HashInputLegacy {
    return {
      fields: [...a.fields, ...b.fields],
      bits: [...a.bits, ...b.bits],
    }
  },
}

/**
 * Convert a boolean[] to a field element (little-endian bit ordering).
 * Bit 0 is the least significant bit.
 */
function bitsToField(bits: boolean[]): bigint {
  let result = 0n
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      result |= 1n << BigInt(i)
    }
  }
  return fieldMod(result)
}

/**
 * Pack a HashInputLegacy into field elements for Poseidon hashing.
 *
 * The bits are packed into field elements, 254 bits at a time
 * (sizeInBits - 1 = 255 - 1 = 254).
 * The resulting packed fields are concatenated AFTER the original fields.
 *
 * This matches o1js `packToFieldsLegacy`.
 */
export function packToFieldsLegacy(input: HashInputLegacy): bigint[] {
  const bitsPerField = 254 // Pallas field is 255 bits, pack 254 bits per element
  const bits = [...input.bits]
  const packedFields: bigint[] = []

  while (bits.length > 0) {
    const chunk = bits.splice(0, bitsPerField)
    packedFields.push(bitsToField(chunk))
  }

  return [...input.fields, ...packedFields]
}

/**
 * Convert a HashInputLegacy to a flat bit array (for nonce derivation).
 *
 * Field elements are converted to 255-bit little-endian representations,
 * then concatenated with the raw bits.
 *
 * This matches o1js `inputToBitsLegacy`.
 */
export function inputToBitsLegacy(input: HashInputLegacy): boolean[] {
  const fieldBits = 255
  const result: boolean[] = []

  // Convert each field to bits
  for (const f of input.fields) {
    const val = fieldMod(f)
    for (let i = 0; i < fieldBits; i++) {
      result.push(((val >> BigInt(i)) & 1n) === 1n)
    }
  }

  // Append raw bits
  result.push(...input.bits)

  return result
}

// ---- Uint bit conversions ----

/**
 * Convert a uint64 value to 64 boolean bits (little-endian).
 */
export function uint64ToBits(value: bigint): boolean[] {
  const bits: boolean[] = []
  for (let i = 0; i < 64; i++) {
    bits.push(((value >> BigInt(i)) & 1n) === 1n)
  }
  return bits
}

/**
 * Convert a uint32 value to 32 boolean bits (little-endian).
 */
export function uint32ToBits(value: bigint): boolean[] {
  const bits: boolean[] = []
  for (let i = 0; i < 32; i++) {
    bits.push(((value >> BigInt(i)) & 1n) === 1n)
  }
  return bits
}

// ---- Memo encoding ----

/**
 * Encode a memo string to bits in Mina's format.
 *
 * Mina memo format (34 bytes total):
 * - Byte 0: 0x01 (marker)
 * - Byte 1: length of the memo string
 * - Bytes 2-33: memo string padded with 0x00
 *
 * The 34 bytes are converted to 272 bits (34 * 8).
 */
export function memoToBits(memo: string): boolean[] {
  const MEMO_SIZE = 34
  const bytes = new Uint8Array(MEMO_SIZE)

  bytes[0] = 0x01 // marker
  const memoStr = memo || ''
  const maxLen = Math.min(memoStr.length, 32)
  bytes[1] = maxLen

  for (let i = 0; i < maxLen; i++) {
    bytes[2 + i] = memoStr.charCodeAt(i)
  }
  // Rest is already 0x00

  // Convert to bits (little-endian per byte)
  const bits: boolean[] = []
  for (let i = 0; i < MEMO_SIZE; i++) {
    for (let j = 0; j < 8; j++) {
      bits.push(((bytes[i] >> j) & 1) === 1)
    }
  }
  return bits
}

// ---- Public key legacy input ----

/**
 * Convert a public key (x-coordinate + y-parity) to legacy hash input.
 *
 * In Mina's legacy format, a public key is represented as:
 * - fields: [x]  (the x-coordinate as a field element)
 * - bits: [isOdd] (boolean: true if y is odd)
 */
export function publicKeyToInputLegacy(x: bigint, isOdd: boolean): HashInputLegacy {
  return { fields: [x], bits: [isOdd] }
}

// ---- Transaction tag ----

/**
 * Convert a transaction tag to bits.
 * Payment = 0 = [false, false, false]
 * StakeDelegation = 1 = [false, false, true]
 */
export function tagToInputBits(tag: 'Payment' | 'StakeDelegation'): boolean[] {
  const int = tag === 'Payment' ? 0 : 1
  return [!!(int & 4), !!(int & 2), !!(int & 1)]
}

// ---- Legacy token ID ----

/**
 * The legacy token ID: a 64-bit value where only bit 0 is true.
 * This represents token ID = 1 in Mina's legacy format.
 */
export const LEGACY_TOKEN_ID: boolean[] = [true, ...new Array<boolean>(63).fill(false)]
