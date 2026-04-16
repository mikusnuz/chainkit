import { describe, it, expect } from 'vitest'
import {
  encodeFunctionSelector,
  encodeFunctionCall,
  encodeAddress,
  encodeUint256,
  encodeInt256,
  encodeBytes32,
  encodeString,
  encodeBool,
  encodeBytes,
  decodeFunctionResult,
  decodeAddress,
  decodeUint256,
  decodeInt256,
  decodeString,
  decodeBool,
  decodeBytes32,
  ERC20,
} from '../abi/index.js'

describe('ABI Encoder', () => {
  describe('encodeFunctionSelector', () => {
    it('should compute transfer(address,uint256) selector', () => {
      const selector = encodeFunctionSelector('transfer(address,uint256)')
      expect(selector).toBe('0xa9059cbb')
    })

    it('should compute balanceOf(address) selector', () => {
      const selector = encodeFunctionSelector('balanceOf(address)')
      expect(selector).toBe('0x70a08231')
    })

    it('should compute approve(address,uint256) selector', () => {
      const selector = encodeFunctionSelector('approve(address,uint256)')
      expect(selector).toBe('0x095ea7b3')
    })

    it('should compute totalSupply() selector', () => {
      const selector = encodeFunctionSelector('totalSupply()')
      expect(selector).toBe('0x18160ddd')
    })

    it('should compute allowance(address,address) selector', () => {
      const selector = encodeFunctionSelector('allowance(address,address)')
      expect(selector).toBe('0xdd62ed3e')
    })
  })

  describe('encodeAddress', () => {
    it('should pad address to 32 bytes', () => {
      const result = encodeAddress('0x1234567890abcdef1234567890abcdef12345678')
      expect(result).toBe('0000000000000000000000001234567890abcdef1234567890abcdef12345678')
      expect(result.length).toBe(64)
    })

    it('should handle address without 0x prefix', () => {
      const result = encodeAddress('1234567890abcdef1234567890abcdef12345678')
      expect(result).toBe('0000000000000000000000001234567890abcdef1234567890abcdef12345678')
    })
  })

  describe('encodeUint256', () => {
    it('should encode zero', () => {
      const result = encodeUint256(0)
      expect(result).toBe('0'.repeat(64))
    })

    it('should encode 1', () => {
      const result = encodeUint256(1)
      expect(result).toBe('0'.repeat(63) + '1')
    })

    it('should encode bigint', () => {
      const result = encodeUint256(1000000000000000000n)
      expect(result).toBe('0000000000000000000000000000000000000000000000000de0b6b3a7640000')
    })

    it('should encode string number', () => {
      const result = encodeUint256('1000')
      expect(result).toBe('0'.repeat(61) + '3e8')
    })

    it('should encode hex string', () => {
      const result = encodeUint256('0xff')
      expect(result).toBe('0'.repeat(62) + 'ff')
    })

    it('should throw for negative values', () => {
      expect(() => encodeUint256(-1)).toThrow()
    })
  })

  describe('encodeInt256', () => {
    it('should encode positive values same as uint256', () => {
      const result = encodeInt256(42)
      expect(result).toBe('0'.repeat(62) + '2a')
    })

    it('should encode negative values as twos complement', () => {
      const result = encodeInt256(-1)
      expect(result).toBe('f'.repeat(64))
    })

    it('should encode -2', () => {
      const result = encodeInt256(-2)
      expect(result).toBe('f'.repeat(63) + 'e')
    })
  })

  describe('encodeBytes32', () => {
    it('should right-pad bytes32', () => {
      const result = encodeBytes32('0xabcdef')
      expect(result).toBe('abcdef' + '0'.repeat(58))
    })

    it('should handle full 32 bytes', () => {
      const hex = 'a'.repeat(64)
      const result = encodeBytes32(hex)
      expect(result).toBe(hex)
    })

    it('should throw for too-long values', () => {
      expect(() => encodeBytes32('a'.repeat(65))).toThrow()
    })
  })

  describe('encodeBool', () => {
    it('should encode true as 1', () => {
      const result = encodeBool(true)
      expect(result).toBe('0'.repeat(63) + '1')
    })

    it('should encode false as 0', () => {
      const result = encodeBool(false)
      expect(result).toBe('0'.repeat(64))
    })
  })

  describe('encodeString', () => {
    it('should encode empty string', () => {
      const result = encodeString('')
      expect(result).toBe('0'.repeat(64)) // just length = 0
    })

    it('should encode "Hello"', () => {
      const result = encodeString('Hello')
      // Length = 5
      const expectedLength = '0'.repeat(63) + '5'
      // "Hello" = 48656c6c6f padded to 32-byte boundary (64 hex chars)
      const expectedData = '48656c6c6f' + '0'.repeat(54)
      expect(result).toBe(expectedLength + expectedData)
    })
  })

  describe('encodeFunctionCall', () => {
    it('should encode balanceOf(address)', () => {
      const addr = '0x1234567890abcdef1234567890abcdef12345678'
      const result = encodeFunctionCall('balanceOf(address)', [addr])
      expect(result.startsWith('0x70a08231')).toBe(true)
      expect(result).toBe(
        '0x70a08231' +
        '0000000000000000000000001234567890abcdef1234567890abcdef12345678',
      )
    })

    it('should encode transfer(address,uint256)', () => {
      const result = encodeFunctionCall('transfer(address,uint256)', [
        '0x1234567890abcdef1234567890abcdef12345678',
        1000n,
      ])
      expect(result.startsWith('0xa9059cbb')).toBe(true)
      // selector + address + uint256
      expect(result.length).toBe(2 + 8 + 64 + 64) // 0x + 4 bytes selector + 32 bytes addr + 32 bytes amount
    })

    it('should encode no-args function', () => {
      const result = encodeFunctionCall('totalSupply()', [])
      expect(result).toBe('0x18160ddd')
    })

    it('should throw on argument count mismatch', () => {
      expect(() => encodeFunctionCall('transfer(address,uint256)', ['0x1234'])).toThrow(
        'Argument count mismatch',
      )
    })
  })
})

describe('ABI Decoder', () => {
  describe('decodeAddress', () => {
    it('should decode a padded address', () => {
      const encoded = '0000000000000000000000001234567890abcdef1234567890abcdef12345678'
      const result = decodeAddress(encoded)
      expect(result).toBe('0x1234567890abcdef1234567890abcdef12345678')
    })

    it('should handle 0x prefix', () => {
      const encoded = '0x0000000000000000000000001234567890abcdef1234567890abcdef12345678'
      const result = decodeAddress(encoded)
      expect(result).toBe('0x1234567890abcdef1234567890abcdef12345678')
    })
  })

  describe('decodeUint256', () => {
    it('should decode zero', () => {
      const result = decodeUint256('0'.repeat(64))
      expect(result).toBe(0n)
    })

    it('should decode 1', () => {
      const result = decodeUint256('0'.repeat(63) + '1')
      expect(result).toBe(1n)
    })

    it('should decode large values', () => {
      const result = decodeUint256('0000000000000000000000000000000000000000000000000de0b6b3a7640000')
      expect(result).toBe(1000000000000000000n)
    })

    it('should handle 0x prefix', () => {
      const result = decodeUint256('0x' + '0'.repeat(63) + '1')
      expect(result).toBe(1n)
    })
  })

  describe('decodeInt256', () => {
    it('should decode positive values', () => {
      const result = decodeInt256('0'.repeat(62) + '2a')
      expect(result).toBe(42n)
    })

    it('should decode -1', () => {
      const result = decodeInt256('f'.repeat(64))
      expect(result).toBe(-1n)
    })

    it('should decode -2', () => {
      const result = decodeInt256('f'.repeat(63) + 'e')
      expect(result).toBe(-2n)
    })
  })

  describe('decodeBool', () => {
    it('should decode true', () => {
      const result = decodeBool('0'.repeat(63) + '1')
      expect(result).toBe(true)
    })

    it('should decode false', () => {
      const result = decodeBool('0'.repeat(64))
      expect(result).toBe(false)
    })
  })

  describe('decodeBytes32', () => {
    it('should decode bytes32', () => {
      const hex = 'abcdef' + '0'.repeat(58)
      const result = decodeBytes32(hex)
      expect(result).toBe('0x' + hex)
    })
  })

  describe('decodeString', () => {
    it('should decode a standard ABI string (with offset)', () => {
      // ABI encoding: offset (32) + length + data
      const offset = '0'.repeat(62) + '20' // offset = 32
      const length = '0'.repeat(63) + '5'  // length = 5
      const data = '48656c6c6f' + '0'.repeat(59) // "Hello" padded
      const result = decodeString(offset + length + data)
      expect(result).toBe('Hello')
    })

    it('should decode empty string', () => {
      const offset = '0'.repeat(62) + '20'
      const length = '0'.repeat(64) // length = 0
      const result = decodeString(offset + length)
      expect(result).toBe('')
    })
  })

  describe('decodeFunctionResult', () => {
    it('should decode a single uint256', () => {
      const data = '0x' + '0'.repeat(63) + '1'
      const result = decodeFunctionResult(['uint256'], data)
      expect(result).toEqual([1n])
    })

    it('should decode address + uint256', () => {
      const addr = '0000000000000000000000001234567890abcdef1234567890abcdef12345678'
      const amount = '0'.repeat(62) + '64'
      const data = '0x' + addr + amount
      const result = decodeFunctionResult(['address', 'uint256'], data)
      expect(result[0]).toBe('0x1234567890abcdef1234567890abcdef12345678')
      expect(result[1]).toBe(100n)
    })

    it('should decode a bool', () => {
      const data = '0x' + '0'.repeat(63) + '1'
      const result = decodeFunctionResult(['bool'], data)
      expect(result).toEqual([true])
    })
  })

  describe('Round-trip encode/decode', () => {
    it('uint256 round-trip', () => {
      const original = 123456789n
      const encoded = encodeUint256(original)
      const decoded = decodeUint256(encoded)
      expect(decoded).toBe(original)
    })

    it('int256 positive round-trip', () => {
      const original = 42n
      const encoded = encodeInt256(original)
      const decoded = decodeInt256(encoded)
      expect(decoded).toBe(original)
    })

    it('int256 negative round-trip', () => {
      const original = -42n
      const encoded = encodeInt256(original)
      const decoded = decodeInt256(encoded)
      expect(decoded).toBe(original)
    })

    it('address round-trip', () => {
      const original = '0x1234567890abcdef1234567890abcdef12345678'
      const encoded = encodeAddress(original)
      const decoded = decodeAddress(encoded)
      expect(decoded).toBe(original)
    })

    it('bool round-trip', () => {
      const trueEncoded = encodeBool(true)
      expect(decodeBool(trueEncoded)).toBe(true)

      const falseEncoded = encodeBool(false)
      expect(decodeBool(falseEncoded)).toBe(false)
    })
  })
})

describe('ERC20 constants', () => {
  it('should have correct function signatures', () => {
    expect(ERC20.transfer).toBe('transfer(address,uint256)')
    expect(ERC20.approve).toBe('approve(address,uint256)')
    expect(ERC20.balanceOf).toBe('balanceOf(address)')
    expect(ERC20.allowance).toBe('allowance(address,address)')
    expect(ERC20.totalSupply).toBe('totalSupply()')
    expect(ERC20.decimals).toBe('decimals()')
    expect(ERC20.symbol).toBe('symbol()')
    expect(ERC20.name).toBe('name()')
  })

  it('should produce correct selectors for ERC20 functions', () => {
    expect(encodeFunctionSelector(ERC20.transfer)).toBe('0xa9059cbb')
    expect(encodeFunctionSelector(ERC20.approve)).toBe('0x095ea7b3')
    expect(encodeFunctionSelector(ERC20.balanceOf)).toBe('0x70a08231')
    expect(encodeFunctionSelector(ERC20.totalSupply)).toBe('0x18160ddd')
    expect(encodeFunctionSelector(ERC20.decimals)).toBe('0x313ce567')
    expect(encodeFunctionSelector(ERC20.symbol)).toBe('0x95d89b41')
    expect(encodeFunctionSelector(ERC20.name)).toBe('0x06fdde03')
    expect(encodeFunctionSelector(ERC20.allowance)).toBe('0xdd62ed3e')
  })
})
