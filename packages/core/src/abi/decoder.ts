/**
 * Decode ABI-encoded function return data into typed values.
 *
 * @param types - Array of Solidity type strings (e.g., ["address", "uint256"])
 * @param data - Hex-encoded return data (with or without "0x" prefix)
 * @returns Array of decoded values
 */
export function decodeFunctionResult(types: string[], data: string): unknown[] {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const results: unknown[] = []

  for (let i = 0; i < types.length; i++) {
    const type = types[i]
    const offset = i * 64

    if (isTypeDynamic(type)) {
      // Read offset to dynamic data
      const dataOffset = parseInt(hex.slice(offset, offset + 64), 16) * 2
      results.push(decodeDynamicValue(type, hex, dataOffset))
    } else {
      const word = hex.slice(offset, offset + 64)
      results.push(decodeStaticValue(type, word))
    }
  }

  return results
}

/**
 * Decode a 32-byte ABI-encoded address.
 *
 * @param data - 64-char hex string or "0x"-prefixed hex
 * @returns Checksummed address with "0x" prefix
 */
export function decodeAddress(data: string): string {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  // Address is in the last 20 bytes (40 hex chars) of the 32-byte word
  const raw = hex.slice(-40).toLowerCase()
  return '0x' + raw
}

/**
 * Decode a 32-byte ABI-encoded uint256.
 *
 * @param data - 64-char hex string or "0x"-prefixed hex
 * @returns BigInt value
 */
export function decodeUint256(data: string): bigint {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const clean = hex.slice(0, 64)
  if (!clean || clean === '0'.repeat(64)) return 0n
  return BigInt('0x' + clean)
}

/**
 * Decode a 32-byte ABI-encoded int256 (two's complement).
 *
 * @param data - 64-char hex string or "0x"-prefixed hex
 * @returns BigInt value (may be negative)
 */
export function decodeInt256(data: string): bigint {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const clean = hex.slice(0, 64).padStart(64, '0')
  const raw = BigInt('0x' + clean)

  // Check sign bit
  const signBit = 1n << 255n
  if (raw >= signBit) {
    return raw - (1n << 256n)
  }
  return raw
}

/**
 * Decode ABI-encoded string data.
 * Expects: offset already resolved, hex starting at the length word.
 *
 * @param data - Hex string starting at the string encoding (length + data)
 * @returns Decoded string
 */
export function decodeString(data: string): string {
  const hex = data.startsWith('0x') ? data.slice(2) : data

  // If the data looks like a full ABI response (starts with offset word),
  // resolve the offset first
  if (hex.length >= 128) {
    // Check if first word is an offset pointing to the start of string data
    const possibleOffset = parseInt(hex.slice(0, 64), 16)
    if (possibleOffset === 32) {
      // This is a standard ABI-encoded string with offset
      return decodeStringAtOffset(hex, 64)
    }
  }

  // Direct decode: first 32 bytes = length, rest = data
  return decodeStringAtOffset(hex, 0)
}

/**
 * Decode a 32-byte ABI-encoded boolean.
 *
 * @param data - 64-char hex string or "0x"-prefixed hex
 * @returns Boolean value
 */
export function decodeBool(data: string): boolean {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const clean = hex.slice(0, 64)
  return BigInt('0x' + (clean || '0')) !== 0n
}

/**
 * Decode ABI-encoded bytes32.
 *
 * @param data - 64-char hex string or "0x"-prefixed hex
 * @returns Hex string with "0x" prefix
 */
export function decodeBytes32(data: string): string {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  return '0x' + hex.slice(0, 64)
}

// ─── Internal Helpers ───

function isTypeDynamic(type: string): boolean {
  if (type === 'string' || type === 'bytes') return true
  if (type.endsWith('[]')) return true
  return false
}

function decodeStaticValue(type: string, word: string): unknown {
  if (type === 'address') return decodeAddress(word)
  if (type === 'bool') return decodeBool(word)
  if (type === 'bytes32') return decodeBytes32(word)
  if (type.startsWith('bytes') && !type.endsWith('[]')) return decodeBytes32(word)
  if (type.startsWith('uint')) return decodeUint256(word)
  if (type.startsWith('int')) return decodeInt256(word)
  // Fallback
  return decodeUint256(word)
}

function decodeDynamicValue(type: string, fullHex: string, offset: number): unknown {
  if (type === 'string') {
    return decodeStringAtOffset(fullHex, offset)
  }
  if (type === 'bytes') {
    return decodeBytesAtOffset(fullHex, offset)
  }
  throw new Error(`Unsupported dynamic type for decoding: ${type}`)
}

function decodeStringAtOffset(hex: string, offset: number): string {
  const lengthHex = hex.slice(offset, offset + 64)
  const length = parseInt(lengthHex, 16)
  if (length === 0) return ''

  const dataStart = offset + 64
  const strHex = hex.slice(dataStart, dataStart + length * 2)

  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(strHex.slice(i * 2, i * 2 + 2), 16)
  }
  return new TextDecoder().decode(bytes)
}

function decodeBytesAtOffset(hex: string, offset: number): string {
  const lengthHex = hex.slice(offset, offset + 64)
  const length = parseInt(lengthHex, 16)
  if (length === 0) return '0x'

  const dataStart = offset + 64
  return '0x' + hex.slice(dataStart, dataStart + length * 2)
}
