import { describe, it, expect } from 'vitest'
import { icon, IconSigner, IconProvider, ICON_HD_PATH } from './index.js'

describe('icon package exports', () => {
  it('should export the icon chain object', () => {
    expect(icon).toBeDefined()
    expect(icon.name).toBe('icon')
    expect(icon.Signer).toBe(IconSigner)
    expect(icon.Provider).toBe(IconProvider)
  })

  it('should export IconSigner class', () => {
    expect(IconSigner).toBeDefined()
    const signer = new IconSigner()
    expect(signer).toBeInstanceOf(IconSigner)
  })

  it('should export IconProvider class', () => {
    expect(IconProvider).toBeDefined()
    const provider = new IconProvider({
      endpoints: ['https://lisbon.net.solidwallet.io/api/v3'],
    })
    expect(provider).toBeInstanceOf(IconProvider)
  })

  it('should export ICON_HD_PATH constant', () => {
    expect(ICON_HD_PATH).toBe("m/44'/74'/0'/0/0")
  })
})
