import { describe, it, expect } from 'vitest'
import { CardanoSigner } from './signer.js'
import * as ed25519 from '@noble/ed25519'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'

const signer = new CardanoSigner()

// Well-known test mnemonic
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// CIP-1852 default path
const CARDANO_PATH = "m/1852'/1815'/0'/0/0"

describe('CardanoSigner', () => {
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
      expect(signer.validateMnemonic('invalid mnemonic phrase that should not work')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a 32-byte private key from a mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key deterministically', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/1852'/1815'/0'/0/0")
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/1852'/1815'/1'/0/0")

      expect(key1).not.toBe(key2)
    })

    it('should throw for an invalid path', async () => {
      await expect(signer.derivePrivateKey(TEST_MNEMONIC, 'invalid')).rejects.toThrow(
        'Invalid derivation path',
      )
    })
  })

  describe('getAddress', () => {
    it('should return a bech32 addr address', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const address = signer.getAddress(privateKey)

      expect(address).toMatch(/^addr1/)
    })

    it('should return the same address deterministically', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)

      expect(addr1).toBe(addr2)
    })

    it('should throw for an invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('signMessage', () => {
    it('should produce a valid ED25519 signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const message = 'Hello, Cardano!'
      const signature = await signer.signMessage(message, privateKey)

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/) // 64 bytes = 128 hex chars

      // Verify the signature
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)
      const sigBytes = hexToBytes(signature.slice(2))
      const msgBytes = new TextEncoder().encode(message)

      const isValid = ed25519.verify(sigBytes, msgBytes, publicKey)
      expect(isValid).toBe(true)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      const sig1 = await signer.signMessage('message 1', privateKey)
      const sig2 = await signer.signMessage('message 2', privateKey)

      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage(message, privateKey)

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should throw for an invalid private key length', async () => {
      await expect(signer.signMessage('test', '0xdead')).rejects.toThrow(
        'Invalid private key length',
      )
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction with hex-encoded data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      // 32-byte hash (simulating a CBOR-serialized tx body hash)
      const txBodyHash = '0x' + bytesToHex(new Uint8Array(32).fill(0xab))

      const signature = await signer.signTransaction(
        {
          from: 'addr1...',
          to: 'addr1...',
          value: '1000000',
          data: txBodyHash,
        },
        privateKey,
      )

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)

      // Verify the signature
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)
      const sigBytes = hexToBytes(signature.slice(2))
      const hashBytes = hexToBytes(txBodyHash.slice(2))

      const isValid = ed25519.verify(sigBytes, hashBytes, publicKey)
      expect(isValid).toBe(true)
    })

    it('should throw when transaction data is missing', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      await expect(
        signer.signTransaction(
          { from: 'addr1...', to: 'addr1...', value: '1000000' },
          privateKey,
        ),
      ).rejects.toThrow('Transaction data')
    })

    it('should hash non-32-byte data with blake2b-256', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      // Provide raw CBOR data (not a 32-byte hash)
      const rawCborData = '0x' + bytesToHex(new Uint8Array(100).fill(0xcd))

      const signature = await signer.signTransaction(
        {
          from: 'addr1...',
          to: 'addr1...',
          value: '1000000',
          data: rawCborData,
        },
        privateKey,
      )

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })
  })

  describe('end-to-end', () => {
    it('should derive key, get address, and sign from the same mnemonic', async () => {
      const mnemonic = signer.generateMnemonic()
      expect(signer.validateMnemonic(mnemonic)).toBe(true)

      const privateKey = await signer.derivePrivateKey(mnemonic, CARDANO_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)

      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^addr1/)

      const signature = await signer.signMessage('test', privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })
  })
})
