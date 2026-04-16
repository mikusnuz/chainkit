import { describe, it, expect } from 'vitest'
import {
  hedera,
  HederaSigner,
  HederaEcdsaSigner,
  HederaProvider,
  HederaRelayProvider,
  HEDERA_DEFAULT_PATH,
  HEDERA_ECDSA_PATH,
} from '../index.js'

describe('hedera package exports', () => {
  it('should export hedera object with correct structure', () => {
    expect(hedera).toBeDefined()
    expect(hedera.name).toBe('hedera')
    expect(hedera.Signer).toBe(HederaSigner)
    expect(hedera.EcdsaSigner).toBe(HederaEcdsaSigner)
    expect(hedera.Provider).toBe(HederaProvider)
    expect(hedera.RelayProvider).toBe(HederaRelayProvider)
  })

  it('should export HederaSigner class', () => {
    expect(HederaSigner).toBeDefined()
    const signer = new HederaSigner()
    expect(signer).toBeInstanceOf(HederaSigner)
  })

  it('should export HederaEcdsaSigner class', () => {
    expect(HederaEcdsaSigner).toBeDefined()
    const signer = new HederaEcdsaSigner()
    expect(signer).toBeInstanceOf(HederaEcdsaSigner)
  })

  it('should export HederaProvider class', () => {
    expect(HederaProvider).toBeDefined()
    const provider = new HederaProvider({
      baseUrl: 'https://testnet.mirrornode.hedera.com',
    })
    expect(provider).toBeInstanceOf(HederaProvider)
  })

  it('should export HederaRelayProvider class', () => {
    expect(HederaRelayProvider).toBeDefined()
    const provider = new HederaRelayProvider({
      relayUrl: 'https://testnet.hashio.io/api',
    })
    expect(provider).toBeInstanceOf(HederaRelayProvider)
  })

  it('should export HEDERA_DEFAULT_PATH constant', () => {
    expect(HEDERA_DEFAULT_PATH).toBe("m/44'/3030'/0'/0'/0'")
  })

  it('should export HEDERA_ECDSA_PATH constant', () => {
    expect(HEDERA_ECDSA_PATH).toBe("m/44'/60'/0'/0/0")
  })
})
