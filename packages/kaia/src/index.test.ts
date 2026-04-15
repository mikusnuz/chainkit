import { describe, it, expect } from 'vitest'
import { kaia, KaiaSigner, KaiaProvider, KAIA_DEFAULT_PATH } from './index.js'

describe('kaia package exports', () => {
  it('should export kaia object with correct name', () => {
    expect(kaia.name).toBe('kaia')
  })

  it('should export KaiaSigner class', () => {
    expect(kaia.Signer).toBe(KaiaSigner)
    expect(new kaia.Signer()).toBeInstanceOf(KaiaSigner)
  })

  it('should export KaiaProvider class', () => {
    expect(kaia.Provider).toBe(KaiaProvider)
  })

  it('should export KAIA_DEFAULT_PATH constant', () => {
    expect(KAIA_DEFAULT_PATH).toBe("m/44'/8217'/0'/0/0")
  })
})
