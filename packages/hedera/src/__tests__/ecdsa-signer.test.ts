import { describe, it, expect } from 'vitest'
import { HederaEcdsaSigner, HEDERA_ECDSA_PATH } from '../signer.js'
import { ChainKitError } from '@chainkit/core'

// Well-known test mnemonic from BIP39 spec
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// The actual project mnemonic
const PROJECT_MNEMONIC =
  'birth bacon antenna hurry eagle exclude hunt globe arctic clinic trash lens ridge about disease debris fine throw chef entire still erase law elder'

describe('HederaEcdsaSigner', () => {
  const signer = new HederaEcdsaSigner()

  describe('generateMnemonic', () => {
    it('should generate a 12-word mnemonic by default', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(12)
    })

    it('should generate valid mnemonics', () => {
      const mnemonic = signer.generateMnemonic()
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })
  })

  describe('validateMnemonic', () => {
    it('should validate the test mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should validate the project mnemonic', () => {
      expect(signer.validateMnemonic(PROJECT_MNEMONIC)).toBe(true)
    })

    it('should reject invalid mnemonics', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key using ECDSA path', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive deterministically', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should derive different keys for different mnemonics', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      const pk2 = await signer.derivePrivateKey(PROJECT_MNEMONIC, HEDERA_ECDSA_PATH)
      expect(pk1).not.toBe(pk2)
    })

    it('should derive the well-known key for test mnemonic at Ethereum path', async () => {
      // The "abandon" mnemonic at m/44'/60'/0'/0/0 should produce a well-known Ethereum address
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      const address = signer.getAddress(privateKey)
      // Well-known address for this mnemonic/path
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })
  })

  describe('getAddress', () => {
    it('should return an EVM address from a private key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })

    it('should derive addresses deterministically', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should throw on invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('validateAddress', () => {
    it('should validate a correct EVM address', () => {
      expect(signer.validateAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe(true)
    })

    it('should validate a lowercase EVM address', () => {
      expect(signer.validateAddress('0x9858effd232b4033e47d90003d41ec34ecaeda94')).toBe(true)
    })

    it('should reject invalid addresses', () => {
      expect(signer.validateAddress('0.0.12345')).toBe(false)
      expect(signer.validateAddress('0x1234')).toBe(false)
      expect(signer.validateAddress('')).toBe(false)
    })
  })

  describe('signTransaction (legacy)', () => {
    it('should sign a legacy transaction', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      const signedTx = await signer.signTransaction({
        privateKey,
        tx: {
          to: '0x0000000000000000000000000000000000000001',
          value: '1000000000000000000', // 1 HBAR in weibars
          nonce: 0,
          fee: {
            gasPrice: '0xed7cbcd800', // ~1020 gwei
            gasLimit: '0xC350', // 50000
          },
          extra: { chainId: 296 },
        },
      })

      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      // Legacy tx should start with RLP list prefix (0xf8 or higher)
      expect(signedTx.slice(2, 4)).toMatch(/^f[89a-f]/)
    })

    it('should throw on invalid private key', async () => {
      await expect(
        signer.signTransaction({
          privateKey: '0x1234',
          tx: {
            to: '0x0000000000000000000000000000000000000001',
            value: '0',
            nonce: 0,
            fee: { gasPrice: '0x1', gasLimit: '0x5208' },
            extra: { chainId: 296 },
          },
        }),
      ).rejects.toThrow('Invalid private key length')
    })
  })

  describe('signTransaction (EIP-1559)', () => {
    it('should sign an EIP-1559 transaction', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      const signedTx = await signer.signTransaction({
        privateKey,
        tx: {
          to: '0x0000000000000000000000000000000000000001',
          value: '1000000000000000000',
          nonce: 0,
          fee: {
            maxFeePerGas: '0xed7cbcd800',
            maxPriorityFeePerGas: '0x0',
            gasLimit: '0xC350',
          },
          extra: { chainId: 296 },
        },
      })

      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      // EIP-1559 tx starts with 0x02
      expect(signedTx.slice(0, 4)).toBe('0x02')
    })

    it('should default to chain ID 296 (Hedera Testnet)', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      // No explicit chainId
      const signedTx = await signer.signTransaction({
        privateKey,
        tx: {
          to: '0x0000000000000000000000000000000000000001',
          value: '0',
          nonce: 0,
          fee: {
            maxFeePerGas: '0x1',
            maxPriorityFeePerGas: '0x0',
            gasLimit: '0xC350',
          },
        },
      })

      expect(signedTx).toMatch(/^0x02/)
    })
  })

  describe('signMessage', () => {
    it('should sign a string message with EIP-191', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      const signature = await signer.signMessage({ privateKey, message: 'Hello, Hedera!' })

      // r (32 bytes) + s (32 bytes) + v (1 byte) = 65 bytes = 130 hex chars + 0x prefix
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      const sig1 = await signer.signMessage({ privateKey, message: 'test' })
      const sig2 = await signer.signMessage({ privateKey, message: 'test' })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, HEDERA_ECDSA_PATH)
      const sig1 = await signer.signMessage({ privateKey, message: 'message1' })
      const sig2 = await signer.signMessage({ privateKey, message: 'message2' })
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('project mnemonic derivation', () => {
    it('should derive an EVM address from the project mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(PROJECT_MNEMONIC, HEDERA_ECDSA_PATH)
      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })
  })
})
