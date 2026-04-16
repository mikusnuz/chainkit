import { describe, it, expect } from 'vitest'
import { SecureKey } from '../utils/secure-key.js'

describe('SecureKey', () => {
  const testHex = '0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727'
  const testHexNoPrefix = '1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727'

  it('should create from 0x-prefixed hex string', () => {
    const key = new SecureKey(testHex)
    expect(key.hex).toBe(testHex)
    expect(key.bytes).toBeInstanceOf(Uint8Array)
    expect(key.bytes.length).toBe(32)
  })

  it('should create from hex string without 0x prefix', () => {
    const key = new SecureKey(testHexNoPrefix)
    expect(key.hex).toBe(testHex)
  })

  it('should create from Uint8Array', () => {
    const bytes = new Uint8Array(32)
    bytes[0] = 0xff
    bytes[31] = 0x01
    const key = new SecureKey(bytes)
    expect(key.bytes[0]).toBe(0xff)
    expect(key.bytes[31]).toBe(0x01)
  })

  it('should make a copy when created from Uint8Array', () => {
    const bytes = new Uint8Array(32)
    bytes[0] = 0xab
    const key = new SecureKey(bytes)
    bytes[0] = 0x00 // mutating the original should not affect the key
    expect(key.bytes[0]).toBe(0xab)
  })

  it('should zero key material on destroy', () => {
    const key = new SecureKey(testHex)
    const bytesRef = key.bytes // grab reference before destroy
    expect(key.isDestroyed).toBe(false)

    key.destroy()

    expect(key.isDestroyed).toBe(true)
    // The underlying buffer should be zeroed
    expect(bytesRef.every(b => b === 0)).toBe(true)
  })

  it('should throw on .bytes access after destroy', () => {
    const key = new SecureKey(testHex)
    key.destroy()
    expect(() => key.bytes).toThrow('SecureKey has been destroyed')
  })

  it('should throw on .hex access after destroy', () => {
    const key = new SecureKey(testHex)
    key.destroy()
    expect(() => key.hex).toThrow('SecureKey has been destroyed')
  })

  it('should be safe to call destroy multiple times', () => {
    const key = new SecureKey(testHex)
    key.destroy()
    key.destroy() // should not throw
    expect(key.isDestroyed).toBe(true)
  })
})
