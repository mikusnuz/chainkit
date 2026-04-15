import { describe, it, expect } from 'vitest'
import { StellarSigner, encodeStrKey, decodeStrKey, encodeSecretStrKey } from '../signer.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'

// Ensure sha512 is set for ed25519
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const STELLAR_PATH = "m/44'/148'/0'"

describe('StellarSigner', () => {
  const signer = new StellarSigner()

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
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)
      expect(privateKey.startsWith('0x')).toBe(true)
      const pkBytes = hexToBytes(privateKey.slice(2))
      expect(pkBytes.length).toBe(32)
    })

    it('should produce deterministic results', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should produce different keys for different accounts', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/148'/0'")
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/148'/1'")
      expect(pk1).not.toBe(pk2)
    })

    it('should reject non-hardened paths for ED25519', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/148'/0"),
      ).rejects.toThrow('hardened')
    })
  })

  describe('getAddress', () => {
    it('should produce a valid Stellar G... address from the test mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)
      const address = signer.getAddress(privateKey)

      // Stellar addresses start with 'G'
      expect(address.startsWith('G')).toBe(true)

      // Stellar addresses are 56 characters (base32 encoded)
      expect(address.length).toBe(56)
    })

    it('should produce deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should reject invalid private key length', () => {
      expect(() => signer.getAddress('0xdeadbeef')).toThrow('Invalid private key length')
    })

    it('should produce an address that can be decoded back', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)
      const address = signer.getAddress(privateKey)

      const { versionByte, key } = decodeStrKey(address)
      expect(versionByte).toBe(0x30) // ED25519 public key version byte

      // The decoded key should match the ED25519 public key
      const pkBytes = hexToBytes(privateKey.slice(2))
      const expectedPublicKey = ed25519.getPublicKey(pkBytes)
      expect(bytesToHex(key)).toBe(bytesToHex(expectedPublicKey))
    })
  })

  describe('StrKey encoding', () => {
    it('should encode and decode a public key correctly', () => {
      const pubKey = new Uint8Array(32).fill(0xab)
      const strKey = encodeStrKey(pubKey)

      expect(strKey.startsWith('G')).toBe(true)
      expect(strKey.length).toBe(56)

      const decoded = decodeStrKey(strKey)
      expect(decoded.versionByte).toBe(0x30)
      expect(bytesToHex(decoded.key)).toBe(bytesToHex(pubKey))
    })

    it('should encode a secret key starting with S', () => {
      const secretKey = new Uint8Array(32).fill(0xcd)
      const strKey = encodeSecretStrKey(secretKey)

      expect(strKey.startsWith('S')).toBe(true)
      expect(strKey.length).toBe(56)
    })

    it('should reject invalid StrKey with bad checksum', () => {
      const pubKey = new Uint8Array(32).fill(0xab)
      const strKey = encodeStrKey(pubKey)

      // Corrupt the last character to break checksum
      const chars = strKey.split('')
      chars[55] = chars[55] === 'A' ? 'B' : 'A'
      const corrupted = chars.join('')

      expect(() => decodeStrKey(corrupted)).toThrow()
    })
  })

  describe('signMessage', () => {
    it('should sign a message and produce a 64-byte signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)
      const signature = await signer.signMessage('Hello, Stellar!', privateKey)

      expect(signature.startsWith('0x')).toBe(true)
      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)
      const sig1 = await signer.signMessage('Hello, Stellar!', privateKey)
      const sig2 = await signer.signMessage('Hello, Stellar!', privateKey)
      expect(sig1).toBe(sig2)
    })

    it('should produce verifiable signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)
      const message = 'Hello, Stellar!'
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
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)
      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage(message, privateKey)

      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction and produce a 64-byte signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)

      // Simulate a transaction hash (32 bytes)
      const fakeTxHash = bytesToHex(new Uint8Array(32).fill(0xab))

      const signature = await signer.signTransaction(
        {
          from: signer.getAddress(privateKey),
          to: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOBD3CAZEAIORB2',
          value: '10000000',
          data: `0x${fakeTxHash}`,
        },
        privateKey,
      )

      expect(signature.startsWith('0x')).toBe(true)
      const sigBytes = hexToBytes(signature.slice(2))
      expect(sigBytes.length).toBe(64)
    })

    it('should reject transaction without data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)

      await expect(
        signer.signTransaction(
          {
            from: signer.getAddress(privateKey),
            to: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOBD3CAZEAIORB2',
            value: '10000000',
          },
          privateKey,
        ),
      ).rejects.toThrow('Transaction data')
    })

    it('should produce verifiable transaction signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, STELLAR_PATH)
      const fakeTxHash = new Uint8Array(32).fill(0xcd)
      const fakeTxHashHex = bytesToHex(fakeTxHash)

      const signature = await signer.signTransaction(
        {
          from: signer.getAddress(privateKey),
          to: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOBD3CAZEAIORB2',
          value: '10000000',
          data: `0x${fakeTxHashHex}`,
        },
        privateKey,
      )

      const sigBytes = hexToBytes(signature.slice(2))
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const valid = ed25519.verify(sigBytes, fakeTxHash, publicKey)
      expect(valid).toBe(true)
    })
  })
})
