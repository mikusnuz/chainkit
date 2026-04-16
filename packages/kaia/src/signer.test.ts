import { describe, it, expect } from 'vitest'
import { KaiaSigner, KAIA_DEFAULT_PATH } from './signer.js'

describe('KaiaSigner', () => {
  const signer = new KaiaSigner()

  // Known test mnemonic (DO NOT use in production)
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  describe('KAIA_DEFAULT_PATH', () => {
    it('should use coin type 8217 for Kaia', () => {
      expect(KAIA_DEFAULT_PATH).toBe("m/44'/8217'/0'/0/0")
    })
  })

  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic by default', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words.length).toBe(12)
    })

    it('should generate a valid 24-word mnemonic with 256-bit strength', () => {
      const mnemonic = signer.generateMnemonic(256)
      const words = mnemonic.split(' ')
      expect(words.length).toBe(24)
    })

    it('should generate unique mnemonics each time', () => {
      const m1 = signer.generateMnemonic()
      const m2 = signer.generateMnemonic()
      expect(m1).not.toBe(m2)
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
    it('should derive a private key from mnemonic using Kaia HD path', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      expect(pk).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive a different key than Ethereum path', async () => {
      const kaiaKey = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      const ethKey = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/0")
      expect(kaiaKey).not.toBe(ethKey)
    })

    it('should be deterministic', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      expect(pk1).toBe(pk2)
    })
  })

  describe('getAddress', () => {
    it('should derive a valid checksummed address from a private key', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      const address = signer.getAddress(pk)

      // Should be 0x-prefixed, 42 chars total
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })

    it('should return same address for same private key', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)
      expect(addr1).toBe(addr2)
    })

    it('should produce a different address than Ethereum for same mnemonic', async () => {
      const kaiaKey = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      const ethKey = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/0")
      const kaiaAddr = signer.getAddress(kaiaKey)
      const ethAddr = signer.getAddress(ethKey)
      expect(kaiaAddr).not.toBe(ethAddr)
    })

    it('should throw on invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('signTransaction', () => {
    it('should sign a legacy transaction', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      const address = signer.getAddress(pk)

      const signedTx = await signer.signTransaction({ privateKey: pk, tx: {
          from: address,
          to: '0x0000000000000000000000000000000000000001',
          value: '1000000000000000000', // 1 KLAY in peb
          fee: {
            gasPrice: '0xba43b7400', // 50 Gpeb
            gasLimit: '0x5208', // 21000
          },
          nonce: 0,
          extra: { chainId: 8217 },
        } })

      expect(signedTx).toMatch(/^0x/)
      expect(signedTx.length).toBeGreaterThan(10)
    })

    it('should sign an EIP-1559 transaction', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      const address = signer.getAddress(pk)

      const signedTx = await signer.signTransaction({ privateKey: pk, tx: {
          from: address,
          to: '0x0000000000000000000000000000000000000001',
          value: '1000000000000000000',
          fee: {
            maxFeePerGas: '0x2540be400', // 10 Gpeb
            maxPriorityFeePerGas: '0x3b9aca00', // 1 Gpeb
            gasLimit: '0x5208',
          },
          nonce: 0,
          extra: { chainId: 8217 },
        } })

      // EIP-1559 transactions start with 0x02
      expect(signedTx).toMatch(/^0x02/)
      expect(signedTx.length).toBeGreaterThan(10)
    })

    it('should require chainId in tx.extra', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      const address = signer.getAddress(pk)

      // Sign without explicit chainId should throw
      await expect(signer.signTransaction({ privateKey: pk, tx: {
          from: address,
          to: '0x0000000000000000000000000000000000000001',
          value: '0',
          fee: {
            gasPrice: '0xba43b7400',
            gasLimit: '0x5208',
          },
          nonce: 0,
        } })).rejects.toThrow('chainId is required')
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)

      const sig = await signer.signMessage({ privateKey: pk, message: 'Hello, Kaia!' })

      // r (64 hex) + s (64 hex) + v (2 hex) = 130 hex chars + 0x prefix
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should sign a bytes message', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      const msgBytes = new TextEncoder().encode('Hello, Kaia!')

      const sig = await signer.signMessage({ privateKey: pk, message: msgBytes })

      expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce same signature for string and equivalent bytes', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)
      const msg = 'Hello, Kaia!'
      const msgBytes = new TextEncoder().encode(msg)

      const sig1 = await signer.signMessage({ privateKey: pk, message: msg })
      const sig2 = await signer.signMessage({ privateKey: pk, message: msgBytes })

      expect(sig1).toBe(sig2)
    })

    it('should produce deterministic signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KAIA_DEFAULT_PATH)

      const sig1 = await signer.signMessage({ privateKey: pk, message: 'test' })
      const sig2 = await signer.signMessage({ privateKey: pk, message: 'test' })

      expect(sig1).toBe(sig2)
    })
  })
})
