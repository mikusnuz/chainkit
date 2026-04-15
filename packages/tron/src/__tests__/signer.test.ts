import { describe, it, expect } from 'vitest'
import { TronSigner, addressToHex, hexToAddress } from '../signer.js'

// Well-known test mnemonic
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const TRON_HD_PATH = "m/44'/195'/0'/0/0"

describe('TronSigner', () => {
  const signer = new TronSigner()

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
      expect(signer.validateMnemonic('invalid mnemonic words that do not form a valid phrase at all here')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a 32-byte private key from mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key deterministically', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/195'/0'/0/1")
      expect(key1).not.toBe(key2)
    })
  })

  describe('getAddress', () => {
    it('should return a Tron address starting with T', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/)
    })

    it('should derive address deterministically', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })

    it('should produce addresses that can be decoded and re-encoded', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      const address = signer.getAddress(privateKey)

      // Decode to hex and re-encode
      const hex = addressToHex(address)
      expect(hex).toMatch(/^41[0-9a-f]{40}$/)

      const reEncoded = hexToAddress(hex)
      expect(reEncoded).toBe(address)
    })
  })

  describe('signMessage', () => {
    it('should sign a message and return a 65-byte hex signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      const signature = await signer.signMessage('Hello Tron!', privateKey)

      // 65 bytes = 130 hex chars + 0x prefix
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce deterministic signatures for the same message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      const sig1 = await signer.signMessage('Hello Tron!', privateKey)
      const sig2 = await signer.signMessage('Hello Tron!', privateKey)
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      const sig1 = await signer.signMessage('Hello Tron!', privateKey)
      const sig2 = await signer.signMessage('Goodbye Tron!', privateKey)
      expect(sig1).not.toBe(sig2)
    })

    it('should handle Uint8Array messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      const msgBytes = new TextEncoder().encode('Hello Tron!')
      const sig = await signer.signMessage(msgBytes, privateKey)
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction with rawDataHex and return a 65-byte signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)

      // This is a fake rawDataHex for testing - just 32 bytes of data
      const fakeRawData = 'a' .repeat(64)

      const tx = {
        from: signer.getAddress(privateKey),
        to: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
        value: '1000000',
        extra: {
          rawDataHex: fakeRawData,
        },
      }

      const signature = await signer.signTransaction(tx, privateKey)
      // 65 bytes = r(32) + s(32) + v(1)
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should throw when rawDataHex is missing', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)

      const tx = {
        from: signer.getAddress(privateKey),
        to: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
        value: '1000000',
      }

      await expect(signer.signTransaction(tx, privateKey)).rejects.toThrow(
        'Tron transactions require rawDataHex',
      )
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      const fakeRawData = 'b'.repeat(64)

      const tx = {
        from: signer.getAddress(privateKey),
        to: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
        value: '1000000',
        extra: { rawDataHex: fakeRawData },
      }

      const sig1 = await signer.signTransaction(tx, privateKey)
      const sig2 = await signer.signTransaction(tx, privateKey)
      expect(sig1).toBe(sig2)
    })
  })

  describe('addressToHex / hexToAddress', () => {
    it('should round-trip convert between base58 and hex', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TRON_HD_PATH)
      const address = signer.getAddress(privateKey)

      const hex = addressToHex(address)
      expect(hex).toMatch(/^41[0-9a-f]{40}$/)

      const back = hexToAddress(hex)
      expect(back).toBe(address)
    })

    it('should reject invalid base58check addresses', () => {
      expect(() => addressToHex('TInvalidAddress123')).toThrow()
    })
  })
})
