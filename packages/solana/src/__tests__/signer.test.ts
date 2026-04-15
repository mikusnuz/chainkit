import { describe, it, expect } from 'vitest'
import { SolanaSigner } from '../signer.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { base58 } from '@scure/base'

// Ensure sha512 is set for ed25519
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SOLANA_PATH = "m/44'/501'/0'/0'"

describe('SolanaSigner', () => {
  const signer = new SolanaSigner()

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
    it('should validate the test mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a 32-byte private key from the test mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)
      expect(privateKey.startsWith('0x')).toBe(true)
      const pkBytes = hexToBytes(privateKey.slice(2))
      expect(pkBytes.length).toBe(32)
    })

    it('should produce deterministic results', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should produce different keys for different paths', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/501'/0'/0'")
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/501'/1'/0'")
      expect(pk1).not.toBe(pk2)
    })

    it('should reject non-hardened paths for ED25519', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/501'/0'/0"),
      ).rejects.toThrow('hardened')
    })
  })

  describe('getAddress', () => {
    it('should produce a valid Solana address from the test mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)
      const address = signer.getAddress(privateKey)

      // Solana addresses are base58-encoded 32-byte public keys (32-44 chars)
      expect(address.length).toBeGreaterThanOrEqual(32)
      expect(address.length).toBeLessThanOrEqual(44)

      // Should be valid base58
      const decoded = base58.decode(address)
      expect(decoded.length).toBe(32)
    })

    it('should produce deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should reject invalid private key length', () => {
      expect(() => signer.getAddress('0xdeadbeef')).toThrow('Invalid private key length')
    })
  })

  describe('signMessage', () => {
    it('should sign a message and produce a 64-byte signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)
      const signature = await signer.signMessage('Hello, Solana!', privateKey)

      expect(signature.startsWith('0x')).toBe(true)
      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)
      const sig1 = await signer.signMessage('Hello, Solana!', privateKey)
      const sig2 = await signer.signMessage('Hello, Solana!', privateKey)
      expect(sig1).toBe(sig2)
    })

    it('should produce verifiable signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)
      const message = 'Hello, Solana!'
      const signature = await signer.signMessage(message, privateKey)

      // Verify the signature
      const sigBytes = hexToBytes(signature.slice(2))
      const msgBytes = new TextEncoder().encode(message)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const valid = ed25519.verify(sigBytes, msgBytes, publicKey)
      expect(valid).toBe(true)
    })

    it('should sign Uint8Array messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)
      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage(message, privateKey)

      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction and produce a 64-byte signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)

      // Simulate a serialized transaction message (32 bytes of blockhash-like data)
      const fakeMessage = bytesToHex(new Uint8Array(64).fill(0xab))

      const signature = await signer.signTransaction(
        {
          from: signer.getAddress(privateKey),
          to: '11111111111111111111111111111111',
          value: '1000000000',
          data: `0x${fakeMessage}`,
        },
        privateKey,
      )

      expect(signature.startsWith('0x')).toBe(true)
      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })

    it('should reject transaction without data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)

      await expect(
        signer.signTransaction(
          {
            from: signer.getAddress(privateKey),
            to: '11111111111111111111111111111111',
            value: '1000000000',
          },
          privateKey,
        ),
      ).rejects.toThrow('Transaction data')
    })

    it('should produce verifiable transaction signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SOLANA_PATH)
      const fakeMessage = new Uint8Array(64).fill(0xcd)
      const fakeMessageHex = bytesToHex(fakeMessage)

      const signature = await signer.signTransaction(
        {
          from: signer.getAddress(privateKey),
          to: '11111111111111111111111111111111',
          value: '1000000000',
          data: `0x${fakeMessageHex}`,
        },
        privateKey,
      )

      const sigBytes = hexToBytes(signature.slice(2))
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const valid = ed25519.verify(sigBytes, fakeMessage, publicKey)
      expect(valid).toBe(true)
    })
  })
})
