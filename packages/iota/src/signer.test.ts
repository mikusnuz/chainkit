import { describe, it, expect } from 'vitest'
import { IotaSigner } from './signer.js'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { blake2b } from '@noble/hashes/blake2b'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { bech32 } from '@scure/base'

// Ensure ed25519 sha512 is set
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

const IOTA_HD_PATH = "m/44'/4218'/0'/0'/0'"
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('IotaSigner', () => {
  const signer = new IotaSigner()

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
    it('should validate a correct mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key from a mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key deterministically', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/4218'/0'/0'/1'")
      expect(key1).not.toBe(key2)
    })

    it('should reject non-hardened paths for ED25519', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, 'm/44/4218/0/0/0'),
      ).rejects.toThrow('hardened')
    })

    it('should reject invalid paths', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, 'invalid'),
      ).rejects.toThrow('Invalid derivation path')
    })
  })

  describe('getAddress', () => {
    it('should return a bech32 address with iota HRP', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^iota1/)
    })

    it('should return a valid bech32 address that decodes correctly', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const address = signer.getAddress(privateKey)

      // Decode and verify structure
      const decoded = bech32.decodeToBytes(address)
      // Should be 33 bytes: 1 type byte (0x00) + 32 hash bytes
      expect(decoded.bytes.length).toBe(33)
      expect(decoded.bytes[0]).toBe(0x00) // Ed25519 address type
    })

    it('should derive the correct address from the public key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      // Manually compute: blake2b-256(pubkey) -> prepend 0x00 -> bech32
      const addressHash = blake2b(publicKey, { dkLen: 32 })
      const addressData = new Uint8Array(33)
      addressData[0] = 0x00
      addressData.set(addressHash, 1)
      const words = bech32.toWords(addressData)
      const expectedAddress = bech32.encode('iota', words, 90)

      const address = signer.getAddress(privateKey)
      expect(address).toBe(expectedAddress)
    })

    it('should produce deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should reject invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction and return a valid signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: '0x' + bytesToHex(new Uint8Array(32).fill(0xab)),
      }

      const signature = await signer.signTransaction(tx, privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/) // 64 bytes = 128 hex chars
    })

    it('should produce verifiable ED25519 signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const essenceData = new Uint8Array(32).fill(0xcd)
      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: '0x' + bytesToHex(essenceData),
      }

      const signature = await signer.signTransaction(tx, privateKey)
      const sigBytes = hexToBytes(signature.slice(2))

      // IOTA signs the blake2b-256 hash of the essence
      const essenceHash = blake2b(essenceData, { dkLen: 32 })
      const valid = ed25519.verify(sigBytes, essenceHash, publicKey)
      expect(valid).toBe(true)
    })

    it('should reject missing transaction data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
      }

      await expect(signer.signTransaction(tx, privateKey)).rejects.toThrow(
        'Transaction data',
      )
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const signature = await signer.signMessage('hello IOTA', privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const msg = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage(msg, privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce verifiable signatures for messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const message = 'verify this message'
      const signature = await signer.signMessage(message, privateKey)
      const sigBytes = hexToBytes(signature.slice(2))

      const msgBytes = new TextEncoder().encode(message)
      const valid = ed25519.verify(sigBytes, msgBytes, publicKey)
      expect(valid).toBe(true)
    })

    it('should reject invalid private key length', async () => {
      await expect(
        signer.signMessage('test', '0xabcdef'),
      ).rejects.toThrow('Invalid private key length')
    })
  })
})
