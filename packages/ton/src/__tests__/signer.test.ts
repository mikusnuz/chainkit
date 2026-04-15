import { describe, it, expect } from 'vitest'
import { TonSigner } from '../signer.js'

// Known test mnemonic (DO NOT use in production)
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// TON HD path
const TON_PATH = "m/44'/607'/0'"

describe('TonSigner', () => {
  const signer = new TonSigner()

  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic by default', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words.length).toBe(12)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate a 24-word mnemonic with 256-bit strength', () => {
      const mnemonic = signer.generateMnemonic(256)
      const words = mnemonic.split(' ')
      expect(words.length).toBe(24)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })
  })

  describe('validateMnemonic', () => {
    it('should validate a correct mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })

    it('should reject an empty string', () => {
      expect(signer.validateMnemonic('')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a deterministic private key from a mnemonic', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)

      expect(pk1).toBe(pk2)
      expect(pk1.startsWith('0x')).toBe(true)
      // 32 bytes = 64 hex chars + '0x' prefix
      expect(pk1.length).toBe(66)
    })

    it('should derive different keys for different paths', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/607'/1'")

      expect(pk1).not.toBe(pk2)
    })

    it('should derive different keys for different mnemonics', async () => {
      const otherMnemonic =
        'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const pk2 = await signer.derivePrivateKey(otherMnemonic, TON_PATH)

      expect(pk1).not.toBe(pk2)
    })
  })

  describe('getAddress', () => {
    it('should return a valid raw address in workchain:hash format', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const address = signer.getAddress(pk)

      // Should be in format "0:<64 hex chars>"
      expect(address).toMatch(/^0:[0-9a-f]{64}$/)
    })

    it('should return deterministic addresses', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)

      expect(addr1).toBe(addr2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('getUserFriendlyAddress', () => {
    it('should return a base64url encoded address', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const address = signer.getUserFriendlyAddress(pk)

      // User-friendly address is 48 chars base64url
      expect(address.length).toBe(48)
      // Should only contain base64url characters
      expect(address).toMatch(/^[A-Za-z0-9_-]+$/)
    })

    it('should produce different addresses for bounceable vs non-bounceable', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const bounceable = signer.getUserFriendlyAddress(pk, true)
      const nonBounceable = signer.getUserFriendlyAddress(pk, false)

      expect(bounceable).not.toBe(nonBounceable)
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const signature = await signer.signMessage('Hello TON', pk)

      expect(signature.startsWith('0x')).toBe(true)
      // ED25519 signature = 64 bytes = 128 hex chars + '0x'
      expect(signature.length).toBe(130)
    })

    it('should sign a Uint8Array message', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const msg = new TextEncoder().encode('Hello TON')
      const signature = await signer.signMessage(msg, pk)

      expect(signature.startsWith('0x')).toBe(true)
      expect(signature.length).toBe(130)
    })

    it('should produce deterministic signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const sig1 = await signer.signMessage('Hello TON', pk)
      const sig2 = await signer.signMessage('Hello TON', pk)

      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const sig1 = await signer.signMessage('Hello TON', pk)
      const sig2 = await signer.signMessage('Goodbye TON', pk)

      expect(sig1).not.toBe(sig2)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const signed = await signer.signTransaction(
        {
          from: signer.getAddress(pk),
          to: '0:' + '1'.repeat(64),
          value: '1000000000', // 1 TON in nanoton
        },
        pk,
      )

      expect(signed.startsWith('0x')).toBe(true)
      // Should contain 64-byte signature + serialized message
      expect(signed.length).toBeGreaterThan(130)
    })

    it('should produce deterministic signed transactions', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: '0:' + '1'.repeat(64),
        value: '1000000000',
        nonce: 1,
      }

      const sig1 = await signer.signTransaction(tx, pk)
      const sig2 = await signer.signTransaction(tx, pk)

      expect(sig1).toBe(sig2)
    })
  })

  describe('verifySignature', () => {
    it('should verify a valid signature', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const pubKey = signer.getPublicKey(pk)
      const message = 'Hello TON'
      const signature = await signer.signMessage(message, pk)

      const isValid = signer.verifySignature(message, signature, pubKey)
      expect(isValid).toBe(true)
    })

    it('should reject an invalid signature', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const pubKey = signer.getPublicKey(pk)
      const signature = await signer.signMessage('Hello TON', pk)

      const isValid = signer.verifySignature('Wrong message', signature, pubKey)
      expect(isValid).toBe(false)
    })
  })

  describe('getPublicKey', () => {
    it('should return a 32-byte ED25519 public key', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const pubKey = signer.getPublicKey(pk)

      expect(pubKey.startsWith('0x')).toBe(true)
      // 32 bytes = 64 hex chars + '0x'
      expect(pubKey.length).toBe(66)
    })

    it('should be deterministic', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, TON_PATH)
      const pub1 = signer.getPublicKey(pk)
      const pub2 = signer.getPublicKey(pk)

      expect(pub1).toBe(pub2)
    })
  })
})
