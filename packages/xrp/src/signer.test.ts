import { describe, it, expect } from 'vitest'
import { decode, verifySignature } from 'xrpl'
import { XrpSigner } from './signer.js'

const signer = new XrpSigner()

// A well-known test mnemonic (DO NOT use in production)
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const XRP_HD_PATH = "m/44'/144'/0'/0/0"

describe('XrpSigner', () => {
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
    it('should return true for a valid mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should return false for an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key from the test mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same private key deterministically', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should derive different keys for different paths', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/144'/0'/0/1")
      expect(pk1).not.toBe(pk2)
    })
  })

  describe('getAddress', () => {
    it('should derive an XRP address starting with r', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/)
    })

    it('should produce deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0xaabb')).toThrow('Invalid private key length')
    })
  })

  describe('signTransaction', () => {
    it('should produce a signed transaction blob', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const fromAddress = signer.getAddress(privateKey)

      // We need a valid destination address too
      const destPk = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/144'/0'/0/1")
      const destAddress = signer.getAddress(destPk)

      const signed = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: destAddress,
          value: '1000000', // 1 XRP in drops
          fee: { fee: '12' },
          nonce: 1,
        } })

      expect(signed).toMatch(/^0x[0-9a-f]+$/)
      // Should be a reasonable length for a signed XRP transaction
      expect(signed.length).toBeGreaterThan(100)
    })

    it('should produce deterministic signatures for same input', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const fromAddress = signer.getAddress(privateKey)
      const destPk = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/144'/0'/0/1")
      const destAddress = signer.getAddress(destPk)

      const tx = {
        from: fromAddress,
        to: destAddress,
        value: '1000000',
        fee: { fee: '12' },
        nonce: 1,
      }

      const sig1 = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      const sig2 = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      expect(sig1).toBe(sig2)
    })

    it('should handle optional destination tag', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const fromAddress = signer.getAddress(privateKey)
      const destPk = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/144'/0'/0/1")
      const destAddress = signer.getAddress(destPk)

      const signed = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: destAddress,
          value: '1000000',
          fee: { fee: '12' },
          nonce: 1,
          extra: { destinationTag: 12345 },
        } })

      expect(signed).toMatch(/^0x[0-9a-f]+$/)
    })

    it('should handle lastLedgerSequence', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const fromAddress = signer.getAddress(privateKey)
      const destPk = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/144'/0'/0/1")
      const destAddress = signer.getAddress(destPk)

      const signed = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: destAddress,
          value: '500000',
          fee: { fee: '15' },
          nonce: 42,
          extra: { lastLedgerSequence: 80000000 },
        } })

      expect(signed).toMatch(/^0x[0-9a-f]+$/)
    })

    it('should produce an XRPL-decodable and verifiable signed payment', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const fromAddress = signer.getAddress(privateKey)
      const destPk = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/144'/0'/0/1")
      const destAddress = signer.getAddress(destPk)

      const signed = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: destAddress,
          value: '1000000',
          fee: { fee: '12' },
          nonce: 1,
          extra: {
            flags: 0,
            destinationTag: 12345,
            lastLedgerSequence: 80000000,
          },
        } })

      const blob = signed.slice(2).toUpperCase()
      const decoded = decode(blob)

      expect(decoded.TransactionType).toBe('Payment')
      expect(decoded.Account).toBe(fromAddress)
      expect(decoded.Destination).toBe(destAddress)
      expect(decoded.Amount).toBe('1000000')
      expect(decoded.Fee).toBe('12')
      expect(decoded.Sequence).toBe(1)
      expect(decoded.Flags).toBe(0)
      expect(decoded.DestinationTag).toBe(12345)
      expect(decoded.LastLedgerSequence).toBe(80000000)
      expect(verifySignature(blob)).toBe(true)
    })

    it('should reject unsupported transaction types', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const fromAddress = signer.getAddress(privateKey)
      const destPk = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/144'/0'/0/1")
      const destAddress = signer.getAddress(destPk)

      await expect(
        signer.signTransaction({ privateKey: privateKey, tx: {
            from: fromAddress,
            to: destAddress,
            value: '1000000',
            extra: { transactionType: 'NonExistent' },
          } }),
      ).rejects.toThrow('Unsupported transaction type')
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'Hello XRP!' })
      expect(signature).toMatch(/^0x[0-9a-f]+$/)
    })

    it('should sign a byte message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const msgBytes = new TextEncoder().encode('Hello XRP!')
      const signature = await signer.signMessage({ privateKey: privateKey, message: msgBytes })
      expect(signature).toMatch(/^0x[0-9a-f]+$/)
    })

    it('should produce DER-encoded signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'Test' })

      // DER signatures start with 0x30 (SEQUENCE tag)
      const sigHex = signature.slice(2) // remove 0x
      expect(sigHex.startsWith('30')).toBe(true)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'Same message' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'Same message' })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, XRP_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'Message A' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'Message B' })
      expect(sig1).not.toBe(sig2)
    })
  })
})
