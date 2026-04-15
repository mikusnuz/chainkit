import { describe, it, expect } from 'vitest'
import { hedera, HederaSigner, HederaProvider, HEDERA_DEFAULT_PATH } from '../index.js'

describe('hedera package exports', () => {
  it('should export hedera object with correct structure', () => {
    expect(hedera).toBeDefined()
    expect(hedera.name).toBe('hedera')
    expect(hedera.Signer).toBe(HederaSigner)
    expect(hedera.Provider).toBe(HederaProvider)
  })

  it('should export HederaSigner class', () => {
    expect(HederaSigner).toBeDefined()
    const signer = new HederaSigner()
    expect(signer).toBeInstanceOf(HederaSigner)
  })

  it('should export HederaProvider class', () => {
    expect(HederaProvider).toBeDefined()
    const provider = new HederaProvider({
      baseUrl: 'https://testnet.mirrornode.hedera.com',
    })
    expect(provider).toBeInstanceOf(HederaProvider)
  })

  it('should export HEDERA_DEFAULT_PATH constant', () => {
    expect(HEDERA_DEFAULT_PATH).toBe("m/44'/3030'/0'/0'/0'")
  })
})
