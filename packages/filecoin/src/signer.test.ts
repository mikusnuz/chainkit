import { describe, it, expect } from 'vitest'
import { FilecoinSigner } from './signer.js'

describe('FilecoinSigner', () => {
  const signer = new FilecoinSigner()

  // Well-known test mnemonic
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const FILECOIN_PATH = "m/44'/461'/0'/0/0"

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
    it('should derive a private key from mnemonic', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, FILECOIN_PATH)
      expect(pk).toMatch(/^0x[0-9a-f]{64}$/i)
    })

    it('should derive deterministic keys', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, FILECOIN_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, FILECOIN_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should derive different keys for different paths', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, FILECOIN_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/461'/0'/0/1")
      expect(pk1).not.toBe(pk2)
    })
  })

  describe('getAddress', () => {
    it('should derive an f1 address from private key', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, FILECOIN_PATH)
      const address = signer.getAddress(pk)

      // f1 address should start with "f1" and be the correct length
      expect(address).toMatch(/^f1[a-z2-7]+$/)
      // f1 addresses are: "f1" + base32(20 bytes payload + 4 bytes checksum)
      // base32 of 24 bytes = ceil(24 * 8 / 5) = 39 characters
      expect(address.length).toBe(2 + 39) // "f1" + 39 base32 chars
    })

    it('should derive deterministic addresses', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, FILECOIN_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)
      expect(addr1).toBe(addr2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction and return a hex signature', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, FILECOIN_PATH)
      const from = signer.getAddress(pk)

      const signature = await signer.signTransaction(
        {
          from,
          to: 'f1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za',
          value: '1000000000000000000', // 1 FIL in attoFIL
          nonce: 0,
          fee: {
            gasLimit: '1000000',
            gasFeeCap: '100000',
            gasPremium: '10000',
          },
        },
        pk,
      )

      // Signature should be 65 bytes (r=32 + s=32 + v=1) = 130 hex chars + 0x prefix
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/i)
    })

    it('should produce deterministic signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, FILECOIN_PATH)
      const from = signer.getAddress(pk)

      const tx = {
        from,
        to: 'f1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za',
        value: '100',
        nonce: 1,
        fee: {
          gasLimit: '500000',
          gasFeeCap: '50000',
          gasPremium: '5000',
        },
      }

      const sig1 = await signer.signTransaction(tx, pk)
      const sig2 = await signer.signTransaction(tx, pk)
      expect(sig1).toBe(sig2)
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, FILECOIN_PATH)

      const signature = await signer.signMessage('hello filecoin', pk)
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/i)
    })

    it('should sign a byte array message', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, FILECOIN_PATH)

      const msg = new TextEncoder().encode('hello filecoin')
      const signature = await signer.signMessage(msg, pk)
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/i)
    })

    it('should produce same signature for string and equivalent bytes', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, FILECOIN_PATH)
      const message = 'test message'

      const sig1 = await signer.signMessage(message, pk)
      const sig2 = await signer.signMessage(new TextEncoder().encode(message), pk)
      expect(sig1).toBe(sig2)
    })
  })
})
