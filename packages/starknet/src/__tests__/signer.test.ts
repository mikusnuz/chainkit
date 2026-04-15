import { describe, it, expect } from 'vitest'
import { StarknetSigner, verifyStarkSignature, getStarkPublicKey, STARK_CURVE } from '../signer.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const STARKNET_PATH = "m/44'/9004'/0'/0/0"

describe('StarknetSigner', () => {
  const signer = new StarknetSigner()

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
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      expect(privateKey.startsWith('0x')).toBe(true)
      const pkBytes = hexToBytes(privateKey.slice(2))
      expect(pkBytes.length).toBe(32)
    })

    it('should produce deterministic results', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should produce different keys for different paths', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/9004'/0'/0/0")
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/9004'/0'/0/1")
      expect(pk1).not.toBe(pk2)
    })

    it('should produce a key within the Stark curve order', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      const pkBigInt = BigInt(privateKey)
      expect(pkBigInt > 0n).toBe(true)
      expect(pkBigInt < STARK_CURVE.N).toBe(true)
    })
  })

  describe('getAddress', () => {
    it('should produce a valid 0x-prefixed 64-char hex address', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      const address = signer.getAddress(privateKey)

      // StarkNet addresses are 0x + 64 hex chars
      expect(address.startsWith('0x')).toBe(true)
      expect(address.length).toBe(66) // 0x + 64 hex chars

      // Should be valid hex
      expect(/^0x[0-9a-f]{64}$/.test(address)).toBe(true)
    })

    it('should produce deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should reject invalid private key length', () => {
      expect(() => signer.getAddress('0xdeadbeef')).toThrow('Invalid private key length')
    })

    it('should produce different addresses for different keys', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/9004'/0'/0/0")
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/9004'/0'/0/1")
      const addr1 = signer.getAddress(pk1)
      const addr2 = signer.getAddress(pk2)
      expect(addr1).not.toBe(addr2)
    })
  })

  describe('signMessage', () => {
    it('should sign a message and produce a 64-byte compact signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      const signature = await signer.signMessage('Hello, StarkNet!', privateKey)

      expect(signature.startsWith('0x')).toBe(true)
      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      const sig1 = await signer.signMessage('Hello, StarkNet!', privateKey)
      const sig2 = await signer.signMessage('Hello, StarkNet!', privateKey)
      expect(sig1).toBe(sig2)
    })

    it('should produce verifiable signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      const message = 'Hello, StarkNet!'
      const signature = await signer.signMessage(message, privateKey)

      const sigBytes = hexToBytes(signature.slice(2))
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = getStarkPublicKey(pkBytes)

      // Verify with the message hash (sha256 of the original message)
      const msgHash = sha256(new TextEncoder().encode(message))
      const valid = verifyStarkSignature(msgHash, sigBytes, publicKey)
      expect(valid).toBe(true)
    })

    it('should sign Uint8Array messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage(message, privateKey)

      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      const sig1 = await signer.signMessage('message1', privateKey)
      const sig2 = await signer.signMessage('message2', privateKey)
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction with data (message hash)', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)

      // Simulate a transaction hash (32 bytes)
      const fakeMsgHash = bytesToHex(new Uint8Array(32).fill(0xab))

      const signature = await signer.signTransaction(
        {
          from: signer.getAddress(privateKey),
          to: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
          value: '1000000000000000000',
          data: `0x${fakeMsgHash}`,
        },
        privateKey,
      )

      expect(signature.startsWith('0x')).toBe(true)
      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })

    it('should reject transaction without data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)

      await expect(
        signer.signTransaction(
          {
            from: signer.getAddress(privateKey),
            to: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
            value: '1000000000000000000',
          },
          privateKey,
        ),
      ).rejects.toThrow('Transaction data')
    })

    it('should produce verifiable transaction signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      const fakeHash = new Uint8Array(32).fill(0xcd)
      const fakeHashHex = bytesToHex(fakeHash)

      const signature = await signer.signTransaction(
        {
          from: signer.getAddress(privateKey),
          to: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
          value: '1000000000000000000',
          data: `0x${fakeHashHex}`,
        },
        privateKey,
      )

      const sigBytes = hexToBytes(signature.slice(2))
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = getStarkPublicKey(pkBytes)

      const valid = verifyStarkSignature(fakeHash, sigBytes, publicKey)
      expect(valid).toBe(true)
    })
  })

  describe('getStarkPublicKey', () => {
    it('should return a 65-byte uncompressed public key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STARKNET_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = getStarkPublicKey(pkBytes)

      expect(publicKey.length).toBe(65)
      expect(publicKey[0]).toBe(0x04) // Uncompressed prefix
    })
  })

  describe('STARK_CURVE constants', () => {
    it('should have valid curve parameters', () => {
      expect(STARK_CURVE.P > 0n).toBe(true)
      expect(STARK_CURVE.N > 0n).toBe(true)
      expect(STARK_CURVE.Gx > 0n).toBe(true)
      expect(STARK_CURVE.Gy > 0n).toBe(true)
      expect(STARK_CURVE.ALPHA).toBe(1n)
      // P should be a 252-bit prime
      expect(STARK_CURVE.P.toString(16).length).toBeLessThanOrEqual(64)
    })
  })
})
