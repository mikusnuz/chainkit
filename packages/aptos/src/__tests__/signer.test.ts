import { describe, it, expect } from 'vitest'
import { AptosSigner } from '../signer.js'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const APTOS_HD_PATH = "m/44'/637'/0'/0'/0'"

describe('AptosSigner', () => {
  const signer = new AptosSigner()

  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic by default', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words.length).toBe(12)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate a valid 24-word mnemonic with 256-bit strength', () => {
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
    it('should derive a private key from a mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, APTOS_HD_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key for the same mnemonic and path', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, APTOS_HD_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, APTOS_HD_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should derive different keys for different paths', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, APTOS_HD_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/637'/1'/0'/0'")
      expect(pk1).not.toBe(pk2)
    })

    it('should throw for non-hardened path segments', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/637'/0'/0/0"),
      ).rejects.toThrow('hardened')
    })
  })

  describe('getAddress', () => {
    it('should return a 0x-prefixed 64-char hex address', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, APTOS_HD_PATH)
      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should return the same address for the same private key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, APTOS_HD_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0xdead')).toThrow('Invalid private key length')
    })
  })

  describe('signMessage', () => {
    it('should produce a valid 64-byte ED25519 signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, APTOS_HD_PATH)
      const signature = await signer.signMessage('hello aptos', privateKey)

      // ED25519 signature is 64 bytes = 128 hex chars
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, APTOS_HD_PATH)
      const sig1 = await signer.signMessage('message one', privateKey)
      const sig2 = await signer.signMessage('message two', privateKey)
      expect(sig1).not.toBe(sig2)
    })

    it('should accept Uint8Array messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, APTOS_HD_PATH)
      const msgBytes = new TextEncoder().encode('hello aptos')
      const sig1 = await signer.signMessage('hello aptos', privateKey)
      const sig2 = await signer.signMessage(msgBytes, privateKey)
      expect(sig1).toBe(sig2)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction with hex-encoded data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, APTOS_HD_PATH)
      const tx = {
        from: signer.getAddress(privateKey),
        to: '0x' + '1'.padStart(64, '0'),
        value: '100000000',
        data: '0x' + 'deadbeef'.repeat(8),
      }

      const signature = await signer.signTransaction(tx, privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should throw when transaction data is missing', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, APTOS_HD_PATH)
      const tx = {
        from: signer.getAddress(privateKey),
        to: '0x' + '1'.padStart(64, '0'),
        value: '100000000',
      }

      await expect(signer.signTransaction(tx, privateKey)).rejects.toThrow(
        'Transaction data',
      )
    })
  })
})
