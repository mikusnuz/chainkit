/**
 * Native TON Cell / BOC (Bag of Cells) implementation.
 * Replaces @ton/core dependency for Cell, beginCell, and BOC serialization/deserialization.
 */

import { sha256 } from '@noble/hashes/sha256'

// ---- CRC32-C (Castagnoli) for BOC checksum ----

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0x82f63b78
      } else {
        crc = crc >>> 1
      }
    }
    table[i] = crc
  }
  return table
})()

function crc32c(data: Uint8Array): Uint8Array {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ data[i]) & 0xff]
  }
  crc = (crc ^ 0xffffffff) >>> 0
  // Little-endian
  return new Uint8Array([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff])
}

// ---- BitBuilder ----

/**
 * Bit-level builder for constructing Cell data.
 */
export class BitBuilder {
  private buffer: Uint8Array
  private length: number

  constructor(capacity = 1023) {
    this.buffer = new Uint8Array(Math.ceil(capacity / 8))
    this.length = 0
  }

  get bitLength(): number {
    return this.length
  }

  writeBit(value: boolean | number): this {
    if (this.length >= this.buffer.length * 8) {
      // Expand
      const newBuf = new Uint8Array(this.buffer.length * 2)
      newBuf.set(this.buffer)
      this.buffer = newBuf
    }
    if (value) {
      this.buffer[this.length >> 3] |= 1 << (7 - (this.length & 7))
    }
    this.length++
    return this
  }

  writeUint(value: number | bigint, bits: number): this {
    const v = BigInt(value)
    for (let i = bits - 1; i >= 0; i--) {
      this.writeBit(Number((v >> BigInt(i)) & 1n))
    }
    return this
  }

  writeInt(value: number | bigint, bits: number): this {
    const v = BigInt(value)
    // Two's complement: for negative values, add 2^bits
    const normalized = v < 0n ? v + (1n << BigInt(bits)) : v
    this.writeUint(normalized, bits)
    return this
  }

  writeBytes(data: Uint8Array): this {
    for (const byte of data) {
      this.writeUint(byte, 8)
    }
    return this
  }

  /**
   * Write a TON address (MsgAddressInt addr_std$10 or addr_none$00).
   */
  writeAddress(address: { workchain: number; hash: Uint8Array } | null): this {
    if (!address) {
      this.writeUint(0, 2) // addr_none$00
      return this
    }
    this.writeUint(2, 2)   // addr_std$10
    this.writeUint(0, 1)   // anycast: nothing$0
    this.writeInt(address.workchain, 8)
    this.writeBytes(address.hash)
    return this
  }

  /**
   * Write a Grams/Coins value (VarUInteger 16).
   * Format: length_in_bytes(4 bits) + value(length_in_bytes * 8 bits)
   */
  writeCoins(value: bigint): this {
    if (value === 0n) {
      this.writeUint(0, 4)
      return this
    }
    const bytesNeeded = Math.ceil(value.toString(16).length / 2)
    this.writeUint(bytesNeeded, 4)
    this.writeUint(value, bytesNeeded * 8)
    return this
  }

  /**
   * Build the final data, returning raw bytes and bit length.
   * Does NOT add completion tag - that is done during cell representation/serialization.
   */
  build(): { data: Uint8Array; bitLength: number } {
    const byteLen = Math.ceil(this.length / 8)
    const data = new Uint8Array(byteLen)
    data.set(this.buffer.subarray(0, byteLen))
    return { data, bitLength: this.length }
  }
}

// ---- Cell ----

/**
 * Immutable TON Cell.
 */
export class Cell {
  readonly data: Uint8Array
  readonly bitLength: number
  readonly refs: Cell[]

  private _hash: Uint8Array | null = null
  private _depth: number | null = null

  constructor(data: Uint8Array, bitLength: number, refs: Cell[] = []) {
    if (refs.length > 4) {
      throw new Error('Cell cannot have more than 4 references')
    }
    if (bitLength > 1023) {
      throw new Error('Cell cannot have more than 1023 bits')
    }
    this.data = data
    this.bitLength = bitLength
    this.refs = refs
  }

  /**
   * Compute the depth of this cell tree.
   * Leaf cells have depth 0, others have max(children depths) + 1.
   */
  depth(): number {
    if (this._depth !== null) return this._depth
    if (this.refs.length === 0) {
      this._depth = 0
    } else {
      let maxDepth = 0
      for (const ref of this.refs) {
        const d = ref.depth()
        if (d > maxDepth) maxDepth = d
      }
      this._depth = maxDepth + 1
    }
    return this._depth
  }

  /**
   * Compute cell representation bytes for hashing.
   * repr = d1 || d2 || data_with_padding || ref_depths || ref_hashes
   */
  private repr(): Uint8Array {
    const refsCount = this.refs.length
    // d1 = refs_descriptor = refs_count (for ordinary cells at level 0)
    const d1 = refsCount
    // d2 = bits_descriptor = ceil(bitLength / 8) + floor(bitLength / 8)
    const d2 = Math.ceil(this.bitLength / 8) + Math.floor(this.bitLength / 8)

    // Data with completion tag padding
    const dataWithPadding = this.paddedData()

    // Build representation
    const parts: Uint8Array[] = [new Uint8Array([d1, d2]), dataWithPadding]

    // Reference depths (2 bytes each, big-endian uint16)
    for (const ref of this.refs) {
      const depth = ref.depth()
      parts.push(new Uint8Array([depth >> 8, depth & 0xff]))
    }

    // Reference hashes (32 bytes each)
    for (const ref of this.refs) {
      parts.push(ref.hash())
    }

    return concatBytes(...parts)
  }

  /**
   * Get data with completion tag padding.
   * If bitLength is not a multiple of 8, add a 1 bit then fill with 0s.
   */
  private paddedData(): Uint8Array {
    const byteLen = Math.ceil(this.bitLength / 8)
    if (byteLen === 0) return new Uint8Array(0)

    const result = new Uint8Array(byteLen)
    result.set(this.data.subarray(0, byteLen))

    if (this.bitLength % 8 !== 0) {
      // Set the completion tag: 1 bit after the data, rest 0
      const lastBitPos = this.bitLength % 8
      // Clear bits after data
      result[byteLen - 1] &= (0xff << (8 - lastBitPos)) & 0xff
      // Set the completion bit
      result[byteLen - 1] |= 1 << (7 - lastBitPos)
    }

    return result
  }

  /**
   * Compute SHA-256 hash of cell representation.
   */
  hash(): Uint8Array {
    if (this._hash) return this._hash
    this._hash = sha256(this.repr())
    return this._hash
  }

  /**
   * Serialize this cell tree to BOC (Bag of Cells) format.
   */
  toBoc(): Uint8Array {
    // Flatten the tree into a topological order (BFS, parent before children)
    const cells = topologicalSort(this)
    const cellIndexMap = new Map<Cell, number>()
    for (let i = 0; i < cells.length; i++) {
      cellIndexMap.set(cells[i], i)
    }

    const cellCount = cells.length
    // Determine ref_byte_size (number of bytes to encode cell indices)
    const refByteSize = cellCount <= 0xff ? 1 : cellCount <= 0xffff ? 2 : cellCount <= 0xffffff ? 3 : 4

    // Serialize each cell
    const cellDataParts: Uint8Array[] = []
    for (const cell of cells) {
      const refsCount = cell.refs.length
      const d1 = refsCount
      const d2 = Math.ceil(cell.bitLength / 8) + Math.floor(cell.bitLength / 8)
      const paddedData = cell.paddedData()

      // d1, d2, data, ref_indices
      const cellPart = new Uint8Array(2 + paddedData.length + refsCount * refByteSize)
      cellPart[0] = d1
      cellPart[1] = d2
      cellPart.set(paddedData, 2)

      let offset = 2 + paddedData.length
      for (const ref of cell.refs) {
        const idx = cellIndexMap.get(ref)!
        writeUintBE(cellPart, offset, idx, refByteSize)
        offset += refByteSize
      }

      cellDataParts.push(cellPart)
    }

    const cellDataBytes = concatBytes(...cellDataParts)
    const totCellsSize = cellDataBytes.length

    // Determine offset_bytes
    const offsetBytes = totCellsSize <= 0xff ? 1 : totCellsSize <= 0xffff ? 2 : totCellsSize <= 0xffffff ? 3 : 4

    // BOC header
    // magic(4) + flags_byte(1) + offset_bytes(1) + cell_count(refByteSize) + roots(refByteSize) + absent(refByteSize) + tot_cells_size(offsetBytes) + root_list(refByteSize)
    const headerSize = 4 + 1 + 1 + refByteSize * 3 + offsetBytes + refByteSize
    const header = new Uint8Array(headerSize)

    // Magic: b5ee9c72
    header[0] = 0xb5
    header[1] = 0xee
    header[2] = 0x9c
    header[3] = 0x72

    // Flags byte: has_idx(0) | has_crc32(1) | has_cache(0) | flags(00) | ref_byte_size
    header[4] = (1 << 6) | refByteSize // 0x40 | refByteSize

    // offset_bytes
    header[5] = offsetBytes

    let pos = 6
    // cell_count
    writeUintBE(header, pos, cellCount, refByteSize)
    pos += refByteSize

    // roots
    writeUintBE(header, pos, 1, refByteSize) // 1 root
    pos += refByteSize

    // absent
    writeUintBE(header, pos, 0, refByteSize)
    pos += refByteSize

    // tot_cells_size
    writeUintBE(header, pos, totCellsSize, offsetBytes)
    pos += offsetBytes

    // root_list (just index 0)
    writeUintBE(header, pos, 0, refByteSize)

    // Combine header + cell data
    const bocWithoutCrc = concatBytes(header, cellDataBytes)

    // CRC32C
    const crc = crc32c(bocWithoutCrc)

    return concatBytes(bocWithoutCrc, crc)
  }

  /**
   * Parse a BOC (Bag of Cells) from binary data.
   * Returns the root cells.
   */
  static fromBoc(data: Uint8Array): Cell[] {
    let pos = 0

    // Magic
    if (data[0] !== 0xb5 || data[1] !== 0xee || data[2] !== 0x9c || data[3] !== 0x72) {
      throw new Error('Invalid BOC magic')
    }
    pos = 4

    // Flags byte
    const flagsByte = data[pos++]
    const hasIdx = (flagsByte >> 7) & 1
    const hasCrc32 = (flagsByte >> 6) & 1
    // const hasCache = (flagsByte >> 5) & 1
    // const flags = (flagsByte >> 3) & 3
    const refByteSize = flagsByte & 7

    // Offset bytes
    const offsetBytes = data[pos++]

    // Cell count
    const cellCount = readUintBE(data, pos, refByteSize)
    pos += refByteSize

    // Roots count
    const rootsCount = readUintBE(data, pos, refByteSize)
    pos += refByteSize

    // Absent count
    // const absentCount = readUintBE(data, pos, refByteSize)
    pos += refByteSize

    // Total cells size
    const totCellsSize = readUintBE(data, pos, offsetBytes)
    pos += offsetBytes

    // Root indices
    const rootIndices: number[] = []
    for (let i = 0; i < rootsCount; i++) {
      rootIndices.push(readUintBE(data, pos, refByteSize))
      pos += refByteSize
    }

    // Skip index if present
    if (hasIdx) {
      pos += cellCount * offsetBytes
    }

    // Parse cells data
    const cellData = data.subarray(pos, pos + totCellsSize)

    // Verify CRC32 if present
    if (hasCrc32) {
      const bocData = data.subarray(0, pos + totCellsSize)
      const expectedCrc = data.subarray(pos + totCellsSize, pos + totCellsSize + 4)
      const computedCrc = crc32c(bocData)
      if (
        computedCrc[0] !== expectedCrc[0] ||
        computedCrc[1] !== expectedCrc[1] ||
        computedCrc[2] !== expectedCrc[2] ||
        computedCrc[3] !== expectedCrc[3]
      ) {
        throw new Error('BOC CRC32 mismatch')
      }
    }

    // Parse each cell descriptor from cellData
    interface CellDescriptor {
      data: Uint8Array
      bitLength: number
      refIndices: number[]
    }
    const descriptors: CellDescriptor[] = []
    let cpos = 0

    for (let i = 0; i < cellCount; i++) {
      const d1 = cellData[cpos++]
      const d2 = cellData[cpos++]
      const refsCount = d1 & 7
      const isExotic = (d1 >> 3) & 1
      const _ = isExotic // suppress unused warning

      // d2 = ceil(bitLen / 8) + floor(bitLen / 8)
      // If d2 is even: bitLen = (d2 / 2) * 8, dataBytes = d2 / 2
      // If d2 is odd: bitLen has a completion tag, dataBytes = (d2 + 1) / 2
      const hasPadding = (d2 & 1) !== 0
      const dataBytes = hasPadding ? (d2 + 1) >> 1 : d2 >> 1
      const rawData = cellData.subarray(cpos, cpos + dataBytes)
      cpos += dataBytes

      let bitLength: number
      if (!hasPadding) {
        bitLength = dataBytes * 8
      } else {
        // Find the completion tag (the last 1 bit) to determine actual bit length
        bitLength = findCompletionBitLength(rawData, dataBytes)
      }

      // Copy data (without the completion tag padding)
      const cellDataArr = new Uint8Array(rawData)

      // Read ref indices
      const refIndices: number[] = []
      for (let j = 0; j < refsCount; j++) {
        refIndices.push(readUintBE(cellData, cpos, refByteSize))
        cpos += refByteSize
      }

      descriptors.push({ data: cellDataArr, bitLength, refIndices })
    }

    // Build cells from bottom up (reverse order since children have higher indices)
    const cells: Cell[] = new Array(cellCount)
    for (let i = cellCount - 1; i >= 0; i--) {
      const desc = descriptors[i]
      const refs = desc.refIndices.map((idx) => cells[idx])
      cells[i] = new Cell(desc.data, desc.bitLength, refs)
    }

    return rootIndices.map((idx) => cells[idx])
  }
}

/**
 * Find the actual bit length of data with a completion tag.
 * The completion tag is the last 1 bit followed by zeros to fill the byte.
 */
function findCompletionBitLength(data: Uint8Array, dataBytes: number): number {
  if (dataBytes === 0) return 0
  const lastByte = data[dataBytes - 1]
  // Find the position of the lowest set bit in the last byte
  // This is the completion tag
  let trailingZeros = 0
  let b = lastByte
  while ((b & 1) === 0 && trailingZeros < 8) {
    trailingZeros++
    b >>= 1
  }
  // The completion bit is at position (7 - trailingZeros) from the MSB,
  // which means (trailingZeros + 1) bits from the LSB are the tag + padding
  return dataBytes * 8 - trailingZeros - 1
}

// ---- CellBuilder ----

/**
 * Builder for constructing Cells with data and references.
 */
export class CellBuilder {
  private bits: BitBuilder
  private _refs: Cell[]

  constructor() {
    this.bits = new BitBuilder(1023)
    this._refs = []
  }

  storeBit(value: boolean | number): this {
    this.bits.writeBit(value)
    return this
  }

  storeUint(value: number | bigint, bits: number): this {
    this.bits.writeUint(value, bits)
    return this
  }

  storeInt(value: number | bigint, bits: number): this {
    this.bits.writeInt(value, bits)
    return this
  }

  storeBytes(data: Uint8Array): this {
    this.bits.writeBytes(data)
    return this
  }

  storeAddress(address: { workchain: number; hash: Uint8Array } | null): this {
    this.bits.writeAddress(address)
    return this
  }

  storeCoins(value: bigint): this {
    this.bits.writeCoins(value)
    return this
  }

  storeRef(cell: Cell): this {
    if (this._refs.length >= 4) {
      throw new Error('Cell cannot have more than 4 references')
    }
    this._refs.push(cell)
    return this
  }

  /**
   * Store another cell's data and refs inline (like storeSlice in @ton/core).
   */
  storeCell(cell: Cell): this {
    // Write bits
    for (let i = 0; i < cell.bitLength; i++) {
      const byteIdx = i >> 3
      const bitIdx = 7 - (i & 7)
      const bit = (cell.data[byteIdx] >> bitIdx) & 1
      this.bits.writeBit(bit)
    }
    // Copy refs
    for (const ref of cell.refs) {
      this.storeRef(ref)
    }
    return this
  }

  endCell(): Cell {
    const { data, bitLength } = this.bits.build()
    return new Cell(data, bitLength, this._refs)
  }
}

/**
 * Convenience function to create a new CellBuilder.
 */
export function beginCell(): CellBuilder {
  return new CellBuilder()
}

// ---- Utilities ----

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

function writeUintBE(buf: Uint8Array, offset: number, value: number, bytes: number): void {
  for (let i = bytes - 1; i >= 0; i--) {
    buf[offset + i] = value & 0xff
    value >>= 8
  }
}

function readUintBE(buf: Uint8Array, offset: number, bytes: number): number {
  let value = 0
  for (let i = 0; i < bytes; i++) {
    value = (value << 8) | buf[offset + i]
  }
  return value
}

/**
 * Topological sort of cell tree (BFS order: parent before children).
 * Deduplicates cells by hash.
 */
function topologicalSort(root: Cell): Cell[] {
  const result: Cell[] = []
  const visited = new Map<string, number>() // hash -> index

  function visit(cell: Cell): void {
    const hashHex = bytesToHexLocal(cell.hash())
    if (visited.has(hashHex)) return

    const index = result.length
    visited.set(hashHex, index)
    result.push(cell)

    for (const ref of cell.refs) {
      visit(ref)
    }
  }

  visit(root)
  return result
}

function bytesToHexLocal(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0')
  }
  return hex
}
