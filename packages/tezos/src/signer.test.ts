import { describe, it, expect } from 'vitest'
import { TezosSigner } from './signer.js'

describe('TezosSigner', () => {
  const signer = new TezosSigner()

  // Known test mnemonic
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  const TEZOS_PATH = "m/44'/1729'/0'/0'"

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
    it('should derive a 32-byte private key from mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key for the same mnemonic and path', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/1729'/0'/0'")
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/1729'/1'/0'")
      expect(key1).not.toBe(key2)
    })

    it('should reject non-hardened paths for ED25519', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/1729'/0'/0"),
      ).rejects.toThrow('hardened')
    })
  })

  describe('getAddress', () => {
    it('should generate a tz1 address from a private key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const address = signer.getAddress(privateKey)

      // tz1 addresses start with "tz1"
      expect(address).toMatch(/^tz1/)
      // tz1 addresses are 36 characters long
      expect(address.length).toBe(36)
    })

    it('should generate deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const address1 = signer.getAddress(privateKey)
      const address2 = signer.getAddress(privateKey)
      expect(address1).toBe(address2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0xabcd')).toThrow('Invalid private key length')
    })
  })

  describe('getPublicKey', () => {
    it('should return an edpk-prefixed public key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const pubKey = signer.getPublicKey(privateKey)
      expect(pubKey).toMatch(/^edpk/)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction and return a hex signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)

      const tx = {
        from: signer.getAddress(privateKey),
        to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        value: '1000000', // 1 XTZ in mutez
        data: '0x' + '00'.repeat(32), // mock forged operation bytes
      }

      const signature = await signer.signTransaction(tx, privateKey)

      // ED25519 signature is 64 bytes = 128 hex chars + 0x prefix
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should throw if no data is provided', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)

      await expect(
        signer.signTransaction(
          { from: 'tz1...', to: 'tz1...', value: '0' },
          privateKey,
        ),
      ).rejects.toThrow('forged operation bytes')
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const signature = await signer.signMessage('Hello Tezos', privateKey)

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const message = new TextEncoder().encode('Hello Tezos')
      const signature = await signer.signMessage(message, privateKey)

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const sig1 = await signer.signMessage('Hello Tezos', privateKey)
      const sig2 = await signer.signMessage('Hello Tezos', privateKey)
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const sig1 = await signer.signMessage('Hello', privateKey)
      const sig2 = await signer.signMessage('World', privateKey)
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('end-to-end: mnemonic -> address', () => {
    it('should derive a consistent tz1 address from a known mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const address = signer.getAddress(privateKey)

      // Address should be valid tz1
      expect(address.startsWith('tz1')).toBe(true)
      expect(address.length).toBe(36)

      // Verify it is stable (snapshot-like test)
      const address2 = signer.getAddress(privateKey)
      expect(address).toBe(address2)
    })
  })
})
