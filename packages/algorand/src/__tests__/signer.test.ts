import { describe, it, expect } from 'vitest'
import { AlgorandSigner, encodeAlgorandAddress, decodeAlgorandAddress } from '../signer.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { sha512_256 } from '@noble/hashes/sha512'

// Ensure sha512 is set for ed25519
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ALGORAND_PATH = "m/44'/283'/0'/0'/0'"

describe('AlgorandSigner', () => {
  const signer = new AlgorandSigner()

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
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      expect(privateKey.startsWith('0x')).toBe(true)
      const pkBytes = hexToBytes(privateKey.slice(2))
      expect(pkBytes.length).toBe(32)
    })

    it('should produce deterministic results', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should produce different keys for different paths', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/283'/0'/0'/0'")
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/283'/1'/0'/0'")
      expect(pk1).not.toBe(pk2)
    })

    it('should reject non-hardened paths for ED25519', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/283'/0'/0'/0"),
      ).rejects.toThrow('hardened')
    })
  })

  describe('getAddress', () => {
    it('should produce a valid 58-character Algorand address', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const address = signer.getAddress(privateKey)

      // Algorand addresses are exactly 58 characters, uppercase
      expect(address.length).toBe(58)
      expect(address).toBe(address.toUpperCase())
    })

    it('should produce deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should produce an address that round-trips through decode/encode', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const address = signer.getAddress(privateKey)

      // Decode the address back to public key
      const publicKey = decodeAlgorandAddress(address)
      expect(publicKey.length).toBe(32)

      // Re-encode should produce the same address
      const reencoded = encodeAlgorandAddress(publicKey)
      expect(reencoded).toBe(address)
    })

    it('should encode the correct public key in the address', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const expectedPubkey = ed25519.getPublicKey(pkBytes)

      const address = signer.getAddress(privateKey)
      const decodedPubkey = decodeAlgorandAddress(address)

      expect(bytesToHex(decodedPubkey)).toBe(bytesToHex(expectedPubkey))
    })

    it('should have a valid SHA-512/256 checksum', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const address = signer.getAddress(privateKey)

      // This should not throw (checksum is verified inside decodeAlgorandAddress)
      const publicKey = decodeAlgorandAddress(address)
      expect(publicKey.length).toBe(32)
    })

    it('should reject invalid private key length', () => {
      expect(() => signer.getAddress('0xdeadbeef')).toThrow('Invalid private key length')
    })
  })

  describe('encodeAlgorandAddress / decodeAlgorandAddress', () => {
    it('should produce addresses that only contain valid base32 characters', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const address = signer.getAddress(privateKey)

      // Valid base32 alphabet (RFC 4648): A-Z, 2-7
      const base32Regex = /^[A-Z2-7]+$/
      expect(base32Regex.test(address)).toBe(true)
    })

    it('should detect invalid checksum in addresses', () => {
      // Create a known-good address and corrupt the last character
      const signer = new AlgorandSigner()
      const goodAddr = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' // 56 A's + 2 more
      // This should throw because the checksum won't match
      expect(() => decodeAlgorandAddress('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toThrow()
    })
  })

  describe('signMessage', () => {
    it('should sign a message and produce a 64-byte signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'Hello, Algorand!' })

      expect(signature.startsWith('0x')).toBe(true)
      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'Hello, Algorand!' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'Hello, Algorand!' })
      expect(sig1).toBe(sig2)
    })

    it('should produce verifiable signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const message = 'Hello, Algorand!'
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
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage({ privateKey: privateKey, message: message })

      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction and produce a 64-byte signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const address = signer.getAddress(privateKey)

      // Simulate a serialized transaction message (64 bytes of test data)
      const fakeMessage = bytesToHex(new Uint8Array(64).fill(0xab))

      const signature = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: address,
          to: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          value: '1000000',
          data: `0x${fakeMessage}`,
        } })

      expect(signature.startsWith('0x')).toBe(true)
      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })

    it('should reject transaction without data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const address = signer.getAddress(privateKey)

      await expect(
        signer.signTransaction({ privateKey: privateKey, tx: {
            from: address,
            to: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            value: '1000000',
          } }),
      ).rejects.toThrow('Transaction data')
    })

    it('should produce verifiable transaction signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ALGORAND_PATH)
      const address = signer.getAddress(privateKey)
      const fakeMessage = new Uint8Array(64).fill(0xcd)
      const fakeMessageHex = bytesToHex(fakeMessage)

      const signature = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: address,
          to: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          value: '1000000',
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
