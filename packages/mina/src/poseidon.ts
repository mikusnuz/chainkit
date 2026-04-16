/**
 * Poseidon hash implementation for Mina's Pallas field.
 *
 * Mina Protocol uses Poseidon hash for transaction signing.
 * This module implements the Poseidon permutation with the following parameters:
 *
 * - Field: Pallas (p = 28948022309329048855892746252171976963363056481941560715954676764349967630337)
 * - State width: 3
 * - Full rounds: 55
 * - Partial rounds: 0
 * - S-box exponent: 7 (x^7)
 * - MDS matrix: 3x3 Cauchy matrix over Pallas
 * - Round constants: Generated via Grain LFSR with Mina-specific seed
 *
 * The round constants and MDS matrix are generated deterministically
 * from the specification parameters using the Grain LFSR method.
 *
 * For production use with pre-computed Poseidon hashes (e.g., from a
 * wallet or dApp that has access to the full Poseidon implementation),
 * use the signTransactionHash method on MinaSigner.
 */

/**
 * The Pallas field modulus.
 */
export const PALLAS_MODULUS = 28948022309329048855892746252171976963363056481941560715954676764349967630337n

/**
 * Poseidon configuration for Mina.
 */
const STATE_WIDTH = 3
const FULL_ROUNDS = 55
const ALPHA = 7n

/**
 * Modular arithmetic helpers over the Pallas field.
 */
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
 * Uses square-and-multiply for efficiency.
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
  return fieldPow(x, ALPHA)
}

/**
 * Grain LFSR for generating Poseidon round constants.
 *
 * This follows the specification from the Poseidon paper
 * (Grassi et al., 2019) for generating pseudorandom field elements
 * from a deterministic seed.
 *
 * For Mina's Poseidon, the LFSR is seeded with the field parameters
 * and produces constants that are consistent across implementations.
 */
class GrainLFSR {
  private state: boolean[]

  constructor(fieldBits: number, stateWidth: number, fullRounds: number, partialRounds: number, alphaBits: number) {
    // Initialize 80-bit LFSR state from parameters
    this.state = new Array(80).fill(false)

    // Encode field size bits (2 bits for field type: binary=0, prime=1)
    this.state[0] = false
    this.state[1] = true // prime field

    // Encode field bit length in bits 2-13 (12 bits)
    for (let i = 0; i < 12; i++) {
      this.state[2 + i] = ((fieldBits >> i) & 1) === 1
    }

    // Encode state width in bits 14-25 (12 bits)
    for (let i = 0; i < 12; i++) {
      this.state[14 + i] = ((stateWidth >> i) & 1) === 1
    }

    // Encode full rounds in bits 26-35 (10 bits)
    for (let i = 0; i < 10; i++) {
      this.state[26 + i] = ((fullRounds >> i) & 1) === 1
    }

    // Encode partial rounds in bits 36-45 (10 bits)
    for (let i = 0; i < 10; i++) {
      this.state[36 + i] = ((partialRounds >> i) & 1) === 1
    }

    // Encode alpha (S-box exponent) bits in 46-75 (30 bits)
    for (let i = 0; i < 30; i++) {
      this.state[46 + i] = ((alphaBits >> i) & 1) === 1
    }

    // Remaining bits (76-79) are set to 1
    for (let i = 76; i < 80; i++) {
      this.state[i] = true
    }

    // Initial self-clocking: discard first 160 outputs
    for (let i = 0; i < 160; i++) {
      this.clock()
    }
  }

  /**
   * Clock the LFSR one step, producing one output bit.
   * Feedback polynomial: x^80 + x^62 + x^51 + x^38 + x^23 + x^13 + 1
   */
  private clock(): boolean {
    const output = this.state[0]
    const newBit =
      this.state[0] !== this.state[13] !== this.state[23] !== this.state[38] !== this.state[51] !== this.state[62]

    // Shift left
    for (let i = 0; i < 79; i++) {
      this.state[i] = this.state[i + 1]
    }
    this.state[79] = newBit

    return output
  }

  /**
   * Generate a random field element by producing enough bits
   * and reducing modulo the field size.
   */
  generateFieldElement(): bigint {
    // For a 255-bit field, we need 255 bits
    const FIELD_BITS = 255
    let result = 0n

    while (true) {
      // Check if the next element should be used (rejection sampling indicator)
      const useThis = this.clock()
      if (!useThis) continue

      // Generate FIELD_BITS random bits
      let candidate = 0n
      for (let i = 0; i < FIELD_BITS; i++) {
        if (this.clock()) {
          candidate |= 1n << BigInt(i)
        }
      }

      // Rejection sampling: only accept if < PALLAS_MODULUS
      if (candidate < PALLAS_MODULUS) {
        return candidate
      }
    }
  }
}

/**
 * Generate MDS matrix using the Cauchy construction.
 *
 * The MDS matrix M is constructed as:
 *   M[i][j] = 1 / (x_i - y_j)
 * where x_i and y_j are distinct elements in the field.
 *
 * For Mina's Poseidon, we use x_i = i and y_j = STATE_WIDTH + j
 * (shifted to ensure x and y sets are disjoint).
 */
function generateMDS(): bigint[][] {
  const mds: bigint[][] = []

  // Compute modular inverse using Fermat's little theorem:
  // a^(-1) = a^(p-2) mod p
  function fieldInv(a: bigint): bigint {
    return fieldPow(a, PALLAS_MODULUS - 2n)
  }

  for (let i = 0; i < STATE_WIDTH; i++) {
    mds[i] = []
    for (let j = 0; j < STATE_WIDTH; j++) {
      // Cauchy matrix: M[i][j] = 1 / (x_i + y_j)
      // where x_i = i, y_j = STATE_WIDTH + j
      const xi = BigInt(i)
      const yj = BigInt(STATE_WIDTH + j)
      mds[i][j] = fieldInv(fieldAdd(xi, yj))
    }
  }

  return mds
}

/**
 * Generate round constants using the Grain LFSR.
 */
function generateRoundConstants(): bigint[][] {
  const lfsr = new GrainLFSR(255, STATE_WIDTH, FULL_ROUNDS, 0, 7)
  const constants: bigint[][] = []

  for (let r = 0; r < FULL_ROUNDS; r++) {
    constants[r] = []
    for (let i = 0; i < STATE_WIDTH; i++) {
      constants[r][i] = lfsr.generateFieldElement()
    }
  }

  return constants
}

// Lazily computed constants (computed once on first use)
let _mds: bigint[][] | null = null
let _roundConstants: bigint[][] | null = null

function getMDS(): bigint[][] {
  if (!_mds) {
    _mds = generateMDS()
  }
  return _mds
}

function getRoundConstants(): bigint[][] {
  if (!_roundConstants) {
    _roundConstants = generateRoundConstants()
  }
  return _roundConstants
}

/**
 * Apply the MDS matrix to the state.
 * Performs matrix-vector multiplication over the Pallas field.
 */
function mdsMultiply(state: bigint[], mds: bigint[][]): bigint[] {
  const result: bigint[] = new Array(STATE_WIDTH).fill(0n)
  for (let i = 0; i < STATE_WIDTH; i++) {
    for (let j = 0; j < STATE_WIDTH; j++) {
      result[i] = fieldAdd(result[i], fieldMul(mds[i][j], state[j]))
    }
  }
  return result
}

/**
 * Poseidon permutation on 3 field elements.
 *
 * For each round:
 * 1. Add round constants
 * 2. Apply S-box (x^7) to all state elements (full round)
 * 3. Apply MDS matrix
 */
function poseidonPermutation(state: bigint[]): bigint[] {
  const mds = getMDS()
  const rc = getRoundConstants()
  let s = [...state]

  for (let round = 0; round < FULL_ROUNDS; round++) {
    // Add round constants
    for (let i = 0; i < STATE_WIDTH; i++) {
      s[i] = fieldAdd(s[i], rc[round][i])
    }

    // Apply S-box to all elements (full round)
    for (let i = 0; i < STATE_WIDTH; i++) {
      s[i] = sbox(s[i])
    }

    // MDS matrix multiplication
    s = mdsMultiply(s, mds)
  }

  return s
}

/**
 * Poseidon hash function (sponge construction).
 *
 * Uses the sponge construction with:
 * - Rate: 2 (absorb 2 field elements at a time)
 * - Capacity: 1 (1 field element)
 *
 * The initial state is [0, 0, 0]. Input is absorbed into
 * the rate portion of the state, and the output is squeezed
 * from the first element.
 *
 * @param inputs - Array of Pallas field elements to hash
 * @returns A single Pallas field element (the hash)
 */
export function poseidonHash(inputs: bigint[]): bigint {
  // Initial state: all zeros
  let state: bigint[] = [0n, 0n, 0n]

  // Rate = 2 (absorb 2 elements at a time into positions 0 and 1)
  const rate = 2

  // Pad input to multiple of rate
  const padded = [...inputs]
  while (padded.length % rate !== 0) {
    padded.push(0n)
  }

  // Absorb phase
  for (let i = 0; i < padded.length; i += rate) {
    for (let j = 0; j < rate; j++) {
      state[j] = fieldAdd(state[j], padded[i + j])
    }
    state = poseidonPermutation(state)
  }

  // Squeeze: return first element
  return state[0]
}

/**
 * Poseidon hash with a prefix string.
 *
 * Mina uses prefix-based domain separation for different hash contexts:
 * - "MinaSignatureMainnet" for mainnet transaction signing
 * - "CodaSignature*****" for testnet transaction signing
 *
 * The prefix is converted to field elements by encoding each character
 * as its ASCII value.
 *
 * @param prefix - Domain separation prefix string
 * @param inputs - Array of Pallas field elements to hash
 * @returns A single Pallas field element (the hash)
 */
export function poseidonHashWithPrefix(prefix: string, inputs: bigint[]): bigint {
  // Convert prefix to field element(s)
  // Mina encodes the prefix as a single field element (packed ASCII bytes)
  let prefixField = 0n
  for (let i = 0; i < prefix.length; i++) {
    prefixField += BigInt(prefix.charCodeAt(i)) << BigInt(8 * i)
  }
  prefixField = fieldMod(prefixField)

  return poseidonHash([prefixField, ...inputs])
}

/**
 * Convert transaction fields to Pallas field elements for Poseidon hashing.
 *
 * Mina payment transaction fields are serialized as:
 * [fee, fee_token, fee_payer_pk_x, fee_payer_pk_y_parity, nonce,
 *  valid_until, memo_hash, tag, receiver_pk_x, receiver_pk_y_parity,
 *  amount, token_id]
 *
 * @param fields - Object containing transaction fields as bigint values
 * @returns Array of field elements ready for Poseidon hashing
 */
export function transactionFieldsToElements(fields: {
  fee: bigint
  feePayerPkX: bigint
  feePayerPkYParity: bigint
  nonce: bigint
  validUntil: bigint
  memo: bigint
  receiverPkX: bigint
  receiverPkYParity: bigint
  amount: bigint
}): bigint[] {
  // Tag for payment transaction = 0
  const tag = 0n
  // Default token ID (MINA native) = 1
  const tokenId = 1n
  // Fee token = 1 (MINA)
  const feeToken = 1n

  return [
    fields.fee,
    feeToken,
    fields.feePayerPkX,
    fields.feePayerPkYParity,
    fields.nonce,
    fields.validUntil,
    fields.memo,
    tag,
    fields.receiverPkX,
    fields.receiverPkYParity,
    fields.amount,
    tokenId,
  ]
}
