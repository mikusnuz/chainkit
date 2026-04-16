import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'

/**
 * Compute the 4-byte function selector from a Solidity function signature.
 * e.g., "transfer(address,uint256)" -> "0xa9059cbb"
 *
 * @param signature - The function signature string
 * @returns The 4-byte selector as a hex string prefixed with "0x"
 */
export function encodeFunctionSelector(signature: string): string {
  const hash = keccak_256(new TextEncoder().encode(signature))
  return '0x' + bytesToHex(hash).slice(0, 8)
}

/**
 * ABI-encode a function call: 4-byte selector + encoded parameters.
 *
 * Supports basic Solidity types: address, uint*, int*, bool, bytes32, string, bytes.
 *
 * @param functionSignature - e.g., "transfer(address,uint256)"
 * @param args - Array of argument values matching the types in the signature
 * @returns ABI-encoded call data as a hex string prefixed with "0x"
 */
export function encodeFunctionCall(functionSignature: string, args: unknown[]): string {
  const selector = encodeFunctionSelector(functionSignature)

  // Parse parameter types from the function signature
  const paramsStart = functionSignature.indexOf('(')
  const paramsEnd = functionSignature.lastIndexOf(')')
  const paramsStr = functionSignature.slice(paramsStart + 1, paramsEnd)
  const types = paramsStr.length > 0 ? splitTypes(paramsStr) : []

  if (types.length !== args.length) {
    throw new Error(
      `Argument count mismatch: signature has ${types.length} params but ${args.length} args were provided`,
    )
  }

  // Separate head (fixed-size) and tail (dynamic) parts
  const heads: string[] = []
  const tails: string[] = []
  const isDynamic = types.map(t => isTypeDynamic(t))

  // Calculate the offset where tail data begins (32 bytes per head entry)
  let tailOffset = types.length * 32

  for (let i = 0; i < types.length; i++) {
    if (isDynamic[i]) {
      // Head contains offset to tail data
      heads.push(encodeUint256(tailOffset))
      const encoded = encodeDynamicValue(types[i], args[i])
      tails.push(encoded)
      tailOffset += encoded.length / 2 // hex chars -> bytes
    } else {
      heads.push(encodeStaticValue(types[i], args[i]))
      tails.push('')
    }
  }

  return selector + heads.join('') + tails.join('')
}

/**
 * ABI-encode an Ethereum address as a 32-byte left-padded value.
 *
 * @param address - The address string (with or without "0x" prefix)
 * @returns 64-character hex string (32 bytes, no "0x" prefix)
 */
export function encodeAddress(address: string): string {
  const clean = address.startsWith('0x') ? address.slice(2) : address
  if (clean.length > 40) {
    throw new Error(`Invalid address length: ${clean.length}`)
  }
  if (!/^[0-9a-fA-F]{1,40}$/.test(clean)) {
    throw new Error('Invalid address: must be hex characters only')
  }
  return clean.toLowerCase().padStart(64, '0')
}

/**
 * ABI-encode a uint256 value as a 32-byte big-endian value.
 *
 * @param value - The value as a string, number, or bigint
 * @returns 64-character hex string (32 bytes, no "0x" prefix)
 */
export function encodeUint256(value: string | number | bigint): string {
  let n: bigint
  if (typeof value === 'bigint') {
    n = value
  } else if (typeof value === 'number') {
    n = BigInt(value)
  } else {
    // Handle hex strings and decimal strings
    if (value.startsWith('0x')) {
      n = BigInt(value)
    } else {
      n = BigInt(value)
    }
  }

  if (n < 0n) {
    throw new Error('Value must be non-negative for uint256')
  }

  const MAX_UINT256 = (1n << 256n) - 1n
  if (n > MAX_UINT256) {
    throw new Error('Value exceeds uint256 max')
  }

  return n.toString(16).padStart(64, '0')
}

/**
 * ABI-encode an int256 value as a 32-byte two's complement big-endian value.
 *
 * @param value - The value as a string, number, or bigint
 * @returns 64-character hex string (32 bytes, no "0x" prefix)
 */
export function encodeInt256(value: string | number | bigint): string {
  let n: bigint
  if (typeof value === 'bigint') {
    n = value
  } else if (typeof value === 'number') {
    n = BigInt(value)
  } else {
    n = BigInt(value)
  }

  if (n >= 0n) {
    return n.toString(16).padStart(64, '0')
  }

  // Two's complement for negative values
  const twosComplement = (1n << 256n) + n
  return twosComplement.toString(16).padStart(64, '0')
}

/**
 * ABI-encode a bytes32 value.
 *
 * @param value - Hex string (with or without "0x" prefix), right-padded to 32 bytes
 * @returns 64-character hex string (32 bytes, no "0x" prefix)
 */
export function encodeBytes32(value: string): string {
  const clean = value.startsWith('0x') ? value.slice(2) : value
  if (clean.length > 64) {
    throw new Error(`bytes32 value too long: ${clean.length} hex chars (max 64)`)
  }
  return clean.padEnd(64, '0')
}

/**
 * ABI-encode a string value (dynamic type).
 * Encoding: length (32 bytes) + data (padded to 32-byte boundary).
 *
 * @param value - The string to encode
 * @returns Hex string (no "0x" prefix) containing length + padded data
 */
export function encodeString(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const length = encodeUint256(bytes.length)

  let dataHex = ''
  for (const b of bytes) {
    dataHex += b.toString(16).padStart(2, '0')
  }

  // Pad to 32-byte boundary
  const paddedLength = Math.ceil(dataHex.length / 64) * 64
  dataHex = dataHex.padEnd(paddedLength, '0')

  return length + dataHex
}

/**
 * ABI-encode a boolean value.
 *
 * @param value - The boolean to encode
 * @returns 64-character hex string (32 bytes, no "0x" prefix)
 */
export function encodeBool(value: boolean): string {
  return value ? '0'.repeat(63) + '1' : '0'.repeat(64)
}

/**
 * ABI-encode raw bytes (dynamic type).
 * Encoding: length (32 bytes) + data (padded to 32-byte boundary).
 *
 * @param value - Hex string (with or without "0x" prefix)
 * @returns Hex string (no "0x" prefix) containing length + padded data
 */
export function encodeBytes(value: string): string {
  const clean = value.startsWith('0x') ? value.slice(2) : value
  const byteLength = clean.length / 2
  const length = encodeUint256(byteLength)

  const paddedLength = Math.ceil(clean.length / 64) * 64
  const paddedData = clean.padEnd(paddedLength, '0')

  return length + paddedData
}

// ─── Internal Helpers ───

/**
 * Split a comma-separated type list, respecting nested parentheses.
 */
function splitTypes(typesStr: string): string[] {
  if (typesStr.trim() === '') return []

  const types: string[] = []
  let depth = 0
  let current = ''

  for (const ch of typesStr) {
    if (ch === '(') depth++
    else if (ch === ')') depth--

    if (ch === ',' && depth === 0) {
      types.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }

  if (current.trim()) types.push(current.trim())
  return types
}

/**
 * Check if a Solidity type is dynamic (variable-length).
 */
function isTypeDynamic(type: string): boolean {
  if (type === 'string' || type === 'bytes') return true
  // Dynamic arrays (e.g., "uint256[]")
  if (type.endsWith('[]')) return true
  return false
}

/**
 * Encode a static (fixed-size) value based on its Solidity type.
 */
function encodeStaticValue(type: string, value: unknown): string {
  if (type === 'address') {
    return encodeAddress(String(value))
  }
  if (type === 'bool') {
    return encodeBool(Boolean(value))
  }
  if (type === 'bytes32') {
    return encodeBytes32(String(value))
  }
  if (type.startsWith('bytes') && !type.endsWith('[]')) {
    // Fixed-size bytes (bytes1..bytes32)
    return encodeBytes32(String(value))
  }
  if (type.startsWith('uint')) {
    return encodeUint256(value as string | number | bigint)
  }
  if (type.startsWith('int')) {
    return encodeInt256(value as string | number | bigint)
  }

  // Fallback: try as uint256
  return encodeUint256(value as string | number | bigint)
}

/**
 * Encode a dynamic (variable-length) value based on its Solidity type.
 */
function encodeDynamicValue(type: string, value: unknown): string {
  if (type === 'string') {
    return encodeString(String(value))
  }
  if (type === 'bytes') {
    return encodeBytes(String(value))
  }

  // Dynamic arrays not implemented in this minimal encoder
  throw new Error(`Unsupported dynamic type: ${type}`)
}
