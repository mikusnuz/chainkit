/**
 * Poseidon hash implementation for Mina's Pallas field.
 *
 * Two variants are supported:
 * 1. Kimchi: 55 full rounds, x^7, no initial ARK
 * 2. Legacy: 63 full rounds, x^5, has initial ARK -- used for transaction signing
 *
 * Reference: https://github.com/o1-labs/o1js/blob/main/src/bindings/crypto/poseidon.ts
 */

import {
  PALLAS_MODULUS,
  KIMCHI_FULL_ROUNDS,
  KIMCHI_ALPHA,
  KIMCHI_MDS,
  KIMCHI_ROUND_CONSTANTS,
  LEGACY_FULL_ROUNDS,
  LEGACY_ALPHA,
  LEGACY_MDS,
  LEGACY_ROUND_CONSTANTS,
  PREFIXES,
} from './poseidon-constants.js'

export { PALLAS_MODULUS }

const STATE_WIDTH = 3

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

function mdsMultiply(state: bigint[], mds: readonly (readonly [bigint, bigint, bigint])[]): bigint[] {
  const result: bigint[] = [0n, 0n, 0n]
  for (let i = 0; i < STATE_WIDTH; i++) {
    for (let j = 0; j < STATE_WIDTH; j++) {
      result[i] = fieldAdd(result[i], fieldMul(mds[i][j], state[j]))
    }
  }
  return result
}

// ---- Permutation ----

interface PoseidonParams {
  fullRounds: number
  alpha: bigint
  mds: readonly (readonly [bigint, bigint, bigint])[]
  roundConstants: readonly (readonly [bigint, bigint, bigint])[]
  hasInitialRoundConstant: boolean
}

/**
 * Poseidon permutation.
 *
 * Order per round: SBOX -> MDS -> ARK
 * If hasInitialRoundConstant, add roundConstants[0] before the loop,
 * and use roundConstants[round + 1] in the loop.
 */
function permutation(state: bigint[], params: PoseidonParams): bigint[] {
  const { fullRounds, alpha, mds, roundConstants, hasInitialRoundConstant } = params
  let s = [...state]

  let offset = 0
  if (hasInitialRoundConstant) {
    for (let i = 0; i < STATE_WIDTH; i++) {
      s[i] = fieldAdd(s[i], roundConstants[0][i])
    }
    offset = 1
  }

  for (let round = 0; round < fullRounds; round++) {
    // SBOX
    for (let i = 0; i < STATE_WIDTH; i++) {
      s[i] = fieldPow(s[i], alpha)
    }

    // MDS + ARK (combined as in o1js)
    const oldState = [...s]
    for (let i = 0; i < STATE_WIDTH; i++) {
      // MDS: dot product of mds[i] with oldState
      let dot = 0n
      for (let j = 0; j < STATE_WIDTH; j++) {
        dot = fieldAdd(dot, fieldMul(mds[i][j], oldState[j]))
      }
      // ARK
      s[i] = fieldAdd(dot, roundConstants[round + offset][i])
    }
  }

  return s
}

function update(state: bigint[], input: bigint[], params: PoseidonParams): bigint[] {
  const rate = 2
  let s = [...state]

  if (input.length === 0) {
    s = permutation(s, params)
    return s
  }

  const n = Math.ceil(input.length / rate) * rate
  const padded = [...input]
  while (padded.length < n) {
    padded.push(0n)
  }

  for (let i = 0; i < n; i += rate) {
    for (let j = 0; j < rate; j++) {
      s[j] = fieldAdd(s[j], padded[i + j])
    }
    s = permutation(s, params)
  }

  return s
}

function initialState(): bigint[] {
  return [0n, 0n, 0n]
}

// ---- Kimchi Poseidon ----

const KIMCHI_PARAMS: PoseidonParams = {
  fullRounds: KIMCHI_FULL_ROUNDS,
  alpha: KIMCHI_ALPHA,
  mds: KIMCHI_MDS,
  roundConstants: KIMCHI_ROUND_CONSTANTS,
  hasInitialRoundConstant: false,
}

export function poseidonUpdate(state: bigint[], input: bigint[]): bigint[] {
  return update(state, input, KIMCHI_PARAMS)
}

export function poseidonInitialState(): bigint[] {
  return initialState()
}

export function poseidonHash(inputs: bigint[]): bigint {
  return update(initialState(), inputs, KIMCHI_PARAMS)[0]
}

// ---- Legacy Poseidon (for transaction signing) ----

const LEGACY_PARAMS: PoseidonParams = {
  fullRounds: LEGACY_FULL_ROUNDS,
  alpha: LEGACY_ALPHA,
  mds: LEGACY_MDS,
  roundConstants: LEGACY_ROUND_CONSTANTS,
  hasInitialRoundConstant: true,
}

export function poseidonLegacyUpdate(state: bigint[], input: bigint[]): bigint[] {
  return update(state, input, LEGACY_PARAMS)
}

export function poseidonLegacyHash(inputs: bigint[]): bigint {
  return update(initialState(), inputs, LEGACY_PARAMS)[0]
}

// ---- Prefix encoding ----

/**
 * Convert a prefix string to a Pallas field element.
 * Encode as UTF-8 bytes, zero-pad to 32 bytes, interpret as LE bigint.
 */
export function prefixToField(prefix: string): bigint {
  const fieldSizeBytes = 32
  if (prefix.length >= fieldSizeBytes) {
    throw new Error('prefix too long')
  }
  const encoder = new TextEncoder()
  const stringBytes = encoder.encode(prefix)
  let result = 0n
  for (let i = 0; i < stringBytes.length; i++) {
    result += BigInt(stringBytes[i]) << BigInt(8 * i)
  }
  return fieldMod(result)
}

// ---- Hash with prefix ----

/**
 * Poseidon Kimchi hash with prefix (domain separation).
 */
export function poseidonHashWithPrefix(prefix: string, inputs: bigint[]): bigint {
  const prefixField = prefixToField(prefix)
  const salted = update(initialState(), [prefixField], KIMCHI_PARAMS)
  return update(salted, inputs, KIMCHI_PARAMS)[0]
}

/**
 * Legacy Poseidon hash with prefix (domain separation).
 * Used by transaction signing (signLegacy).
 */
export function poseidonLegacyHashWithPrefix(prefix: string, inputs: bigint[]): bigint {
  const prefixField = prefixToField(prefix)
  const salted = update(initialState(), [prefixField], LEGACY_PARAMS)
  return update(salted, inputs, LEGACY_PARAMS)[0]
}

// ---- Legacy hash input format ----

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
 * Pack HashInputLegacy into field elements.
 * Bits are packed 254 at a time, then concatenated after the fields.
 */
export function packToFieldsLegacy(input: HashInputLegacy): bigint[] {
  const bitsPerField = 254
  const bits = [...input.bits]
  const packedFields: bigint[] = []

  while (bits.length > 0) {
    const chunk = bits.splice(0, bitsPerField)
    packedFields.push(bitsToField(chunk))
  }

  return [...input.fields, ...packedFields]
}

/**
 * Convert HashInputLegacy to a flat bit array (for nonce derivation).
 */
export function inputToBitsLegacy(input: HashInputLegacy): boolean[] {
  const fieldBits = 255
  const result: boolean[] = []

  for (const f of input.fields) {
    const val = fieldMod(f)
    for (let i = 0; i < fieldBits; i++) {
      result.push(((val >> BigInt(i)) & 1n) === 1n)
    }
  }

  result.push(...input.bits)
  return result
}

// ---- Uint bit conversions ----

export function uint64ToBits(value: bigint): boolean[] {
  const bits: boolean[] = []
  for (let i = 0; i < 64; i++) {
    bits.push(((value >> BigInt(i)) & 1n) === 1n)
  }
  return bits
}

export function uint32ToBits(value: bigint): boolean[] {
  const bits: boolean[] = []
  for (let i = 0; i < 32; i++) {
    bits.push(((value >> BigInt(i)) & 1n) === 1n)
  }
  return bits
}

// ---- Memo encoding ----

export function memoToBits(memo: string): boolean[] {
  const MEMO_SIZE = 34
  const bytes = new Uint8Array(MEMO_SIZE)

  bytes[0] = 0x01
  const memoStr = memo || ''
  const maxLen = Math.min(memoStr.length, 32)
  bytes[1] = maxLen

  for (let i = 0; i < maxLen; i++) {
    bytes[2 + i] = memoStr.charCodeAt(i)
  }

  const bits: boolean[] = []
  for (let i = 0; i < MEMO_SIZE; i++) {
    for (let j = 0; j < 8; j++) {
      bits.push(((bytes[i] >> j) & 1) === 1)
    }
  }
  return bits
}

// ---- Public key legacy input ----

export function publicKeyToInputLegacy(x: bigint, isOdd: boolean): HashInputLegacy {
  return { fields: [x], bits: [isOdd] }
}

// ---- Transaction tag ----

export function tagToInputBits(tag: 'Payment' | 'StakeDelegation'): boolean[] {
  const int = tag === 'Payment' ? 0 : 1
  return [!!(int & 4), !!(int & 2), !!(int & 1)]
}

// ---- Legacy token ID ----

export const LEGACY_TOKEN_ID: boolean[] = [true, ...new Array<boolean>(63).fill(false)]
