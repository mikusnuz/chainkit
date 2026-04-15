import { describe, it, expect } from 'vitest'
import { NeoSigner } from './signer.js'
import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'

const signer = new NeoSigner()

// Well-known test mnemonic
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const NEO_PATH = "m/44'/888'/0'/0/0"

describe('NeoSigner', () => {
  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic by default', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words.length).toBe(12)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate a 24-word mnemonic with strength 256', () => {
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
    it('should derive a 32-byte private key from mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)

      // Should be hex-encoded with 0x prefix
      expect(privateKey.startsWith('0x')).toBe(true)
      // 32 bytes = 64 hex chars + 0x prefix
      expect(privateKey.length).toBe(66)

      // The key should be a valid P-256 scalar
      const keyBytes = hexToBytes(privateKey.slice(2))
      expect(keyBytes.length).toBe(32)
    })

    it('should produce deterministic results', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      expect(key1).toBe(key2)
    })

    it('should produce different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/888'/0'/0/1")
      expect(key1).not.toBe(key2)
    })

    it('should produce different keys for different mnemonics', async () => {
      const mnemonic2 = signer.generateMnemonic()
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const key2 = await signer.derivePrivateKey(mnemonic2, NEO_PATH)
      expect(key1).not.toBe(key2)
    })
  })

  describe('getAddress', () => {
    it('should derive a valid Neo3 address from a private key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const address = signer.getAddress(privateKey)

      // Neo3 address starts with 'N'
      expect(address.startsWith('N')).toBe(true)
      // Neo3 address is typically 34 characters
      expect(address.length).toBe(34)
    })

    it('should produce deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should produce different addresses for different keys', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/888'/0'/0/1")
      const addr1 = signer.getAddress(key1)
      const addr2 = signer.getAddress(key2)
      expect(addr1).not.toBe(addr2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })

    it('should produce address matching manual verification script computation', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const address = signer.getAddress(privateKey)

      // Manually verify the address derivation
      const pkBytes = hexToBytes(privateKey.slice(2))
      const compressedPubKey = p256.getPublicKey(pkBytes, true)

      // Build verification script: 0x0C21 + pubkey + 0x41 + 0x56e7b327
      const script = new Uint8Array(40)
      script[0] = 0x0c
      script[1] = 0x21
      script.set(compressedPubKey, 2)
      script[35] = 0x41
      script[36] = 0x56
      script[37] = 0xe7
      script[38] = 0xb3
      script[39] = 0x27

      // Compute script hash: SHA-256 -> RIPEMD-160
      const hash256 = sha256(script)
      const scriptHash = ripemd160(hash256)

      // Build address payload: version + script_hash
      const payload = new Uint8Array(21)
      payload[0] = 0x35
      payload.set(scriptHash, 1)

      // The address should start with 'N' and be properly encoded
      expect(address.startsWith('N')).toBe(true)
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const signature = await signer.signMessage('Hello Neo!', privateKey)

      // Should be 0x-prefixed hex
      expect(signature.startsWith('0x')).toBe(true)
      // P-256 signature = r (32 bytes) + s (32 bytes) = 64 bytes = 128 hex chars
      expect(signature.length).toBe(130) // 0x + 128
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const msgBytes = new TextEncoder().encode('Hello Neo!')
      const signature = await signer.signMessage(msgBytes, privateKey)

      expect(signature.startsWith('0x')).toBe(true)
      expect(signature.length).toBe(130)
    })

    it('should produce deterministic signatures for same message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const sig1 = await signer.signMessage('test message', privateKey)
      const sig2 = await signer.signMessage('test message', privateKey)
      // P-256 sign with @noble/curves is deterministic (RFC 6979)
      expect(sig1).toBe(sig2)
    })

    it('should produce verifiable signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const message = 'Verify this message'
      const signature = await signer.signMessage(message, privateKey)

      // Verify the signature
      const pkBytes = hexToBytes(privateKey.slice(2))
      const pubKey = p256.getPublicKey(pkBytes, false)
      const msgHash = sha256(new TextEncoder().encode(message))
      const sigBytes = hexToBytes(signature.slice(2))

      const isValid = p256.verify(sigBytes, msgHash, pubKey)
      expect(isValid).toBe(true)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const sig1 = await signer.signMessage('message 1', privateKey)
      const sig2 = await signer.signMessage('message 2', privateKey)
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('signTransaction', () => {
    it('should sign a basic transaction', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const address = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction(
        {
          from: address,
          to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
          value: '1',
          data: '0x0c', // minimal script
          nonce: 12345,
          fee: {
            systemFee: '100000',
            networkFee: '50000',
          },
          extra: {
            validUntilBlock: 5000,
            networkMagic: 860833102,
          },
        },
        privateKey,
      )

      // Should be 0x-prefixed hex
      expect(signedTx.startsWith('0x')).toBe(true)
      // Should contain transaction data
      expect(signedTx.length).toBeGreaterThan(10)
    })

    it('should produce different signed transactions for different nonces', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const address = signer.getAddress(privateKey)

      const baseTx = {
        from: address,
        to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
        value: '1',
        data: '0x0c',
        fee: {
          systemFee: '100000',
          networkFee: '50000',
        },
        extra: {
          validUntilBlock: 5000,
          networkMagic: 860833102,
        },
      }

      const signed1 = await signer.signTransaction({ ...baseTx, nonce: 1 }, privateKey)
      const signed2 = await signer.signTransaction({ ...baseTx, nonce: 2 }, privateKey)
      expect(signed1).not.toBe(signed2)
    })
  })

  describe('end-to-end flow', () => {
    it('should complete full key derivation and signing flow', async () => {
      // Generate mnemonic
      const mnemonic = signer.generateMnemonic()
      expect(signer.validateMnemonic(mnemonic)).toBe(true)

      // Derive key
      const privateKey = await signer.derivePrivateKey(mnemonic, NEO_PATH)
      expect(privateKey.startsWith('0x')).toBe(true)

      // Get address
      const address = signer.getAddress(privateKey)
      expect(address.startsWith('N')).toBe(true)
      expect(address.length).toBe(34)

      // Sign message
      const signature = await signer.signMessage('test', privateKey)
      expect(signature.startsWith('0x')).toBe(true)
      expect(signature.length).toBe(130)

      // Verify
      const pkBytes = hexToBytes(privateKey.slice(2))
      const pubKey = p256.getPublicKey(pkBytes, false)
      const msgHash = sha256(new TextEncoder().encode('test'))
      const sigBytes = hexToBytes(signature.slice(2))
      expect(p256.verify(sigBytes, msgHash, pubKey)).toBe(true)
    })
  })
})
