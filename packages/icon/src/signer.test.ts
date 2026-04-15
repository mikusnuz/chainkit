import { describe, it, expect } from 'vitest'
import { IconSigner, ICON_HD_PATH } from './signer.js'

describe('IconSigner', () => {
  const signer = new IconSigner()

  // Deterministic test mnemonic
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic by default', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words.length).toBe(12)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate a valid 24-word mnemonic with strength 256', () => {
      const mnemonic = signer.generateMnemonic(256)
      const words = mnemonic.split(' ')
      expect(words.length).toBe(24)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })
  })

  describe('validateMnemonic', () => {
    it('should return true for a valid mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should return false for an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a 32-byte private key from mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive deterministic keys', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/74'/0'/0/1")
      expect(key1).not.toBe(key2)
    })
  })

  describe('getAddress', () => {
    it('should derive an hx-prefixed address from a private key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const address = signer.getAddress(privateKey)

      // ICON address format: hx + 40 hex chars
      expect(address).toMatch(/^hx[0-9a-f]{40}$/)
    })

    it('should derive deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })

    it('should produce an address different from Ethereum for the same key', async () => {
      // The address derivation is the same algorithm but different prefix
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const address = signer.getAddress(privateKey)

      // Should start with 'hx', not '0x'
      expect(address.startsWith('hx')).toBe(true)
      expect(address.length).toBe(42) // 2 prefix + 40 hex
    })
  })

  describe('signTransaction', () => {
    it('should sign a basic ICX transfer transaction', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const from = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from,
          to: 'hx1000000000000000000000000000000000000000',
          value: '1000000000000000000', // 1 ICX in loop
          extra: {
            nid: '0x1',
            timestamp: '0x5850adcbef6b8',
          },
        } })

      // Result should be hex-encoded JSON
      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)

      // Decode and verify structure
      const hexStr = signedTx.slice(2)
      const bytes = new Uint8Array(hexStr.length / 2)
      for (let i = 0; i < hexStr.length; i += 2) {
        bytes[i / 2] = parseInt(hexStr.slice(i, i + 2), 16)
      }
      const jsonStr = new TextDecoder().decode(bytes)
      const txObj = JSON.parse(jsonStr)

      expect(txObj.version).toBe('0x3')
      expect(txObj.from).toBe(from)
      expect(txObj.to).toBe('hx1000000000000000000000000000000000000000')
      expect(txObj.value).toBe('0xde0b6b3a7640000')
      expect(txObj.nid).toBe('0x1')
      expect(txObj.stepLimit).toBe('0x186a0')
      expect(txObj.signature).toBeDefined()
      expect(typeof txObj.signature).toBe('string')
      // Signature should be base64 encoded (65 bytes -> ~88 chars in base64)
      expect(txObj.signature.length).toBeGreaterThan(40)
    })

    it('should include nonce when provided', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const from = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from,
          to: 'hx1000000000000000000000000000000000000000',
          value: '0',
          nonce: 5,
          extra: {
            nid: '0x1',
            timestamp: '0x5850adcbef6b8',
          },
        } })

      const hexStr = signedTx.slice(2)
      const bytes = new Uint8Array(hexStr.length / 2)
      for (let i = 0; i < hexStr.length; i += 2) {
        bytes[i / 2] = parseInt(hexStr.slice(i, i + 2), 16)
      }
      const txObj = JSON.parse(new TextDecoder().decode(bytes))
      expect(txObj.nonce).toBe('0x5')
    })

    it('should use custom stepLimit when provided', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const from = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from,
          to: 'hx1000000000000000000000000000000000000000',
          value: '0',
          fee: { stepLimit: '0x2faf080' },
          extra: {
            nid: '0x1',
            timestamp: '0x5850adcbef6b8',
          },
        } })

      const hexStr = signedTx.slice(2)
      const bytes = new Uint8Array(hexStr.length / 2)
      for (let i = 0; i < hexStr.length; i += 2) {
        bytes[i / 2] = parseInt(hexStr.slice(i, i + 2), 16)
      }
      const txObj = JSON.parse(new TextDecoder().decode(bytes))
      expect(txObj.stepLimit).toBe('0x2faf080')
    })

    it('should produce different signatures for different transactions', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const from = signer.getAddress(privateKey)

      const tx1 = await signer.signTransaction({ privateKey: privateKey, tx: {
          from,
          to: 'hx1000000000000000000000000000000000000000',
          value: '1000000000000000000',
          extra: { nid: '0x1', timestamp: '0x5850adcbef6b8' },
        } })

      const tx2 = await signer.signTransaction({ privateKey: privateKey, tx: {
          from,
          to: 'hx2000000000000000000000000000000000000000',
          value: '2000000000000000000',
          extra: { nid: '0x1', timestamp: '0x5850adcbef6b9' },
        } })

      expect(tx1).not.toBe(tx2)
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'Hello ICON' })

      // 65 bytes: r(32) + s(32) + v(1) = 130 hex + 2 for v + 2 for '0x'
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const msgBytes = new TextEncoder().encode('Hello ICON')
      const signature = await signer.signMessage({ privateKey: privateKey, message: msgBytes })

      expect(signature).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'Hello ICON' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'Hello ICON' })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICON_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'Hello' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'World' })
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('ICON_HD_PATH', () => {
    it('should be the correct ICON BIP44 path', () => {
      expect(ICON_HD_PATH).toBe("m/44'/74'/0'/0/0")
    })
  })
})
