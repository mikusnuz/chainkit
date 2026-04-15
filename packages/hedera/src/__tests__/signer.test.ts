import { describe, it, expect } from 'vitest'
import { HederaSigner, HEDERA_DEFAULT_PATH } from '../signer.js'
import { ChainKitError } from '@chainkit/core'

// Well-known test mnemonic from BIP39 spec
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('HederaSigner', () => {
  const signer = new HederaSigner()

  describe('generateMnemonic', () => {
    it('should generate a 12-word mnemonic by default', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(12)
    })

    it('should generate a 24-word mnemonic with 256 bits', () => {
      const mnemonic = signer.generateMnemonic(256)
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(24)
    })

    it('should generate valid mnemonics', () => {
      const mnemonic = signer.generateMnemonic()
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate different mnemonics each time', () => {
      const m1 = signer.generateMnemonic()
      const m2 = signer.generateMnemonic()
      expect(m1).not.toBe(m2)
    })
  })

  describe('validateMnemonic', () => {
    it('should validate the test mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject invalid mnemonics', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
      expect(signer.validateMnemonic('')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key from the test mnemonic using Hedera default path', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_DEFAULT_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same private key deterministically', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_DEFAULT_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_DEFAULT_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should derive different keys for different paths', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/3030'/0'/0'/0'")
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/3030'/0'/0'/1'")
      expect(pk1).not.toBe(pk2)
    })

    it('should throw on invalid path format', async () => {
      await expect(signer.derivePrivateKey(TEST_MNEMONIC, 'invalid')).rejects.toThrow(
        ChainKitError,
      )
    })

    it('should throw on non-hardened path segments', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/3030'/0'/0/0"),
      ).rejects.toThrow('hardened')
    })
  })

  describe('getAddress', () => {
    it('should return a hex-encoded public key from a private key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_DEFAULT_PATH)
      const address = signer.getAddress(privateKey)

      // ED25519 public key is 32 bytes = 64 hex chars
      expect(address).toMatch(/^[0-9a-f]{64}$/)
    })

    it('should derive the same address deterministically', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_DEFAULT_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should throw on invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction and return a valid signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_DEFAULT_PATH)
      const tx = {
        from: '0.0.12345',
        to: '0.0.67890',
        value: '100000000',
        data: '0x' + '00'.repeat(32),
      }

      const signature = await signer.signTransaction({ privateKey: privateKey, tx: tx })

      // ED25519 signature is 64 bytes = 128 hex chars + 0x prefix
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should throw when tx.data is missing', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_DEFAULT_PATH)
      const tx = {
        from: '0.0.12345',
        to: '0.0.67890',
        value: '100000000',
      }

      await expect(signer.signTransaction({ privateKey: privateKey, tx: tx })).rejects.toThrow(
        'Transaction data',
      )
    })

    it('should throw on invalid private key', async () => {
      const tx = {
        from: '0.0.12345',
        to: '0.0.67890',
        value: '100000000',
        data: '0x' + '00'.repeat(32),
      }

      await expect(signer.signTransaction({ privateKey: '0x1234', tx: tx })).rejects.toThrow(
        'Invalid private key length',
      )
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_DEFAULT_PATH)
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'Hello, Hedera!' })

      // ED25519 signature is 64 bytes = 128 hex chars + 0x prefix
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_DEFAULT_PATH)
      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage({ privateKey: privateKey, message: message })

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_DEFAULT_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'test message' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'test message' })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_DEFAULT_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'message1' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'message2' })
      expect(sig1).not.toBe(sig2)
    })

    it('should throw on invalid private key', async () => {
      await expect(signer.signMessage({ privateKey: '0x1234', message: 'hello' })).rejects.toThrow(
        'Invalid private key length',
      )
    })
  })

  describe('HEDERA_DEFAULT_PATH', () => {
    it('should be the correct Hedera BIP44 path', () => {
      expect(HEDERA_DEFAULT_PATH).toBe("m/44'/3030'/0'/0'/0'")
    })
  })
})
