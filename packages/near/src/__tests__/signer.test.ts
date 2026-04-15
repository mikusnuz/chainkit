import { describe, it, expect } from 'vitest'
import { NearSigner } from '../signer.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'

// Ensure sha512 is set for ed25519
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const NEAR_PATH = "m/44'/397'/0'"

describe('NearSigner', () => {
  const signer = new NearSigner()

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
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)
      expect(privateKey.startsWith('0x')).toBe(true)
      const pkBytes = hexToBytes(privateKey.slice(2))
      expect(pkBytes.length).toBe(32)
    })

    it('should produce deterministic results', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should produce different keys for different paths', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/397'/0'")
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/397'/1'")
      expect(pk1).not.toBe(pk2)
    })

    it('should reject non-hardened paths for ED25519', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/397'/0"),
      ).rejects.toThrow('hardened')
    })
  })

  describe('getAddress', () => {
    it('should produce a valid 64-char hex implicit account from the test mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)
      const address = signer.getAddress(privateKey)

      // NEAR implicit accounts are 64 hex characters (32 bytes)
      expect(address.length).toBe(64)

      // Should be valid hex (no 0x prefix)
      expect(/^[0-9a-f]{64}$/.test(address)).toBe(true)

      // Should match the ED25519 public key
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)
      expect(address).toBe(bytesToHex(publicKey))
    })

    it('should produce deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)
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
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'Hello, NEAR!' })

      expect(signature.startsWith('0x')).toBe(true)
      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'Hello, NEAR!' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'Hello, NEAR!' })
      expect(sig1).toBe(sig2)
    })

    it('should produce verifiable signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)
      const message = 'Hello, NEAR!'
      const signature = await signer.signMessage({ privateKey: privateKey, message: message })

      // Verify the signature
      const sigBytes = hexToBytes(signature.slice(2))
      const msgBytes = new TextEncoder().encode(message)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const valid = ed25519.verify(sigBytes, msgBytes, publicKey)
      expect(valid).toBe(true)
    })

    it('should sign Uint8Array messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)
      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage({ privateKey: privateKey, message: message })

      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction and produce a 64-byte signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)

      // Simulate a serialized transaction message (64 bytes of data)
      const fakeMessage = bytesToHex(new Uint8Array(64).fill(0xab))

      const signature = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: signer.getAddress(privateKey),
          to: 'receiver.near',
          value: '1000000000000000000000000',
          data: `0x${fakeMessage}`,
        } })

      expect(signature.startsWith('0x')).toBe(true)
      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })

    it('should reject transaction without data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)

      await expect(
        signer.signTransaction({ privateKey: privateKey, tx: {
            from: signer.getAddress(privateKey),
            to: 'receiver.near',
            value: '1000000000000000000000000',
          } }),
      ).rejects.toThrow('Transaction data')
    })

    it('should produce verifiable transaction signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEAR_PATH)
      const fakeMessage = new Uint8Array(64).fill(0xcd)
      const fakeMessageHex = bytesToHex(fakeMessage)

      const signature = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: signer.getAddress(privateKey),
          to: 'receiver.near',
          value: '1000000000000000000000000',
          data: `0x${fakeMessageHex}`,
        } })

      const sigBytes = hexToBytes(signature.slice(2))
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const valid = ed25519.verify(sigBytes, fakeMessage, publicKey)
      expect(valid).toBe(true)
    })
  })
})
