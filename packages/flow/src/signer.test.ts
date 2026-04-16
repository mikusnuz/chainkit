import { describe, it, expect } from 'vitest'
import { FlowSigner } from './signer.js'

const signer = new FlowSigner()

// Well-known test mnemonic
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const FLOW_HD_PATH = "m/44'/539'/0'/0/0"

describe('FlowSigner', () => {
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

    it('should reject an empty string', () => {
      expect(signer.validateMnemonic('')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key from a mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)

      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key deterministically', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)

      expect(pk1).toBe(pk2)
    })

    it('should derive different keys for different paths', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/539'/0'/0/0")
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/539'/0'/0/1")

      expect(pk1).not.toBe(pk2)
    })

    it('should derive different keys for different mnemonics', async () => {
      const otherMnemonic =
        'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const pk2 = await signer.derivePrivateKey(otherMnemonic, FLOW_HD_PATH)

      expect(pk1).not.toBe(pk2)
    })

    it('should reject an invalid path', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, 'invalid'),
      ).rejects.toThrow('Invalid derivation path')
    })
  })

  describe('getAddress', () => {
    it('should return a Flow-format address (0x + 16 hex chars)', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const address = signer.getAddress(privateKey)

      // Flow addresses: 0x + 16 hex chars (8 bytes)
      expect(address).toMatch(/^0x[0-9a-f]{16}$/)
    })

    it('should return the same address for the same key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)

      expect(addr1).toBe(addr2)
    })

    it('should return different addresses for different keys', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/539'/0'/0/0")
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/539'/0'/0/1")

      expect(signer.getAddress(pk1)).not.toBe(signer.getAddress(pk2))
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('getPublicKey', () => {
    it('should return a 128-char hex public key (64 bytes, no 04 prefix)', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const publicKey = signer.getPublicKey(privateKey)

      // 0x + 128 hex chars = 64 bytes (x + y coordinates)
      expect(publicKey).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should be deterministic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const pk1 = signer.getPublicKey(privateKey)
      const pk2 = signer.getPublicKey(privateKey)

      expect(pk1).toBe(pk2)
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'Hello Flow' })

      // Signature should be 0x + 128 hex chars (r: 32 bytes + s: 32 bytes)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const msg = new TextEncoder().encode('Hello Flow')
      const signature = await signer.signMessage({ privateKey: privateKey, message: msg })

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce the same signature for string and equivalent bytes', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'Hello Flow' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: new TextEncoder().encode('Hello Flow') })

      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'Hello Flow' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'Goodbye Flow' })

      expect(sig1).not.toBe(sig2)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction with raw data payload', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)

      // Simulate a Flow transaction payload (hex-encoded), raw mode (no 'to' field)
      const payload = '0x' + Buffer.from('test-transaction-payload').toString('hex')

      const signature = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: '0x1234567890abcdef',
          value: '0',
          data: payload,
        } })

      // r + s = 64 bytes = 128 hex chars
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should build and sign a FLOW transfer transaction', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)

      const result = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: '0x1234567890abcdef',
          to: '0xfedcba0987654321',
          value: '100000000', // 1.0 FLOW in 10^-8 units
          extra: {
            senderAddress: '0x1234567890abcdef',
            sequenceNumber: 0,
            referenceBlockId: 'a' .repeat(64),
            fungibleTokenAddress: '0xf233dcee88fe0abe',
            flowTokenAddress: '0x1654653399040a61',
          },
        } })

      // Transfer mode returns a JSON string for broadcast
      const txBody = JSON.parse(result)
      expect(txBody).toHaveProperty('script')
      expect(txBody).toHaveProperty('arguments')
      expect(txBody).toHaveProperty('payer')
      expect(txBody).toHaveProperty('envelope_signatures')
      expect(txBody.envelope_signatures.length).toBe(1)
    })

    it('should throw if neither data nor to+value is provided', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)

      await expect(
        signer.signTransaction({ privateKey: privateKey, tx: { from: '0x1234567890abcdef', value: '0' } }),
      ).rejects.toThrow('must have either data')
    })
  })

  describe('verifySignature', () => {
    it('should verify a valid signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const publicKey = signer.getPublicKey(privateKey)
      const message = 'Hello Flow'

      const signature = await signer.signMessage({ privateKey: privateKey, message: message })
      const isValid = signer.verifySignature(message, signature, publicKey)

      expect(isValid).toBe(true)
    })

    it('should reject a signature with wrong message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const publicKey = signer.getPublicKey(privateKey)

      const signature = await signer.signMessage({ privateKey: privateKey, message: 'Hello Flow' })
      const isValid = signer.verifySignature('Wrong message', signature, publicKey)

      expect(isValid).toBe(false)
    })

    it('should reject a signature with wrong public key', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/539'/0'/0/0")
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/539'/0'/0/1")
      const wrongPublicKey = signer.getPublicKey(pk2)

      const signature = await signer.signMessage({ privateKey: pk1, message: 'Hello Flow' })
      const isValid = signer.verifySignature('Hello Flow', signature, wrongPublicKey)

      expect(isValid).toBe(false)
    })

    it('should handle Uint8Array messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const publicKey = signer.getPublicKey(privateKey)
      const message = new Uint8Array([1, 2, 3, 4, 5])

      const signature = await signer.signMessage({ privateKey: privateKey, message: message })
      const isValid = signer.verifySignature(message, signature, publicKey)

      expect(isValid).toBe(true)
    })

    it('should return false for invalid signature format', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, FLOW_HD_PATH)
      const publicKey = signer.getPublicKey(privateKey)

      expect(signer.verifySignature('test', '0x1234', publicKey)).toBe(false)
    })
  })

  describe('end-to-end flow', () => {
    it('should generate mnemonic -> derive key -> get address -> sign -> verify', async () => {
      const mnemonic = signer.generateMnemonic()
      expect(signer.validateMnemonic(mnemonic)).toBe(true)

      const privateKey = await signer.derivePrivateKey(mnemonic, FLOW_HD_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)

      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^0x[0-9a-f]{16}$/)

      const publicKey = signer.getPublicKey(privateKey)
      expect(publicKey).toMatch(/^0x[0-9a-f]{128}$/)

      const message = 'Flow blockchain test message'
      const signature = await signer.signMessage({ privateKey: privateKey, message: message })
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)

      const isValid = signer.verifySignature(message, signature, publicKey)
      expect(isValid).toBe(true)
    })
  })
})
