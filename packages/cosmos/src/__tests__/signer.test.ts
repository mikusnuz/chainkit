import { describe, it, expect } from 'vitest'
import { CosmosSigner } from '../signer.js'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const COSMOS_HD_PATH = "m/44'/118'/0'/0/0"

describe('CosmosSigner', () => {
  const signer = new CosmosSigner()

  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(12)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate a valid 24-word mnemonic', () => {
      const mnemonic = signer.generateMnemonic(256)
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(24)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate unique mnemonics', () => {
      const m1 = signer.generateMnemonic()
      const m2 = signer.generateMnemonic()
      expect(m1).not.toBe(m2)
    })
  })

  describe('validateMnemonic', () => {
    it('should validate the test mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject invalid mnemonics', () => {
      expect(signer.validateMnemonic('invalid words here')).toBe(false)
      expect(signer.validateMnemonic('')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a 0x-prefixed private key from the test mnemonic', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      expect(pk).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should produce deterministic keys', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should produce different keys for different paths', async () => {
      const pk0 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/118'/0'/0/0")
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/118'/0'/0/1")
      expect(pk0).not.toBe(pk1)
    })

    it('should produce a different key than the Ethereum path', async () => {
      const cosmosPk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const ethPk = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/0")
      expect(cosmosPk).not.toBe(ethPk)
    })
  })

  describe('getAddress', () => {
    it('should return a valid cosmos1 bech32 address', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const address = signer.getAddress(pk)

      // cosmos1... bech32 format
      expect(address).toMatch(/^cosmos1[a-z0-9]{38}$/)
    })

    it('should produce deterministic addresses', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)
      expect(addr1).toBe(addr2)
    })

    it('should match the expected address for the test mnemonic', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const address = signer.getAddress(pk)
      // Known cosmos address for the "abandon" test mnemonic at m/44'/118'/0'/0/0
      expect(address).toBe('cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4')
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('getAddress with custom prefix', () => {
    it('should generate addresses with custom prefix', async () => {
      const osmSigner = new CosmosSigner('osmo')
      const pk = await osmSigner.derivePrivateKey(TEST_MNEMONIC, "m/44'/118'/0'/0/0")
      const address = osmSigner.getAddress(pk)
      expect(address).toMatch(/^osmo1/)
    })
  })

  describe('signMessage', () => {
    it('should produce a valid 64-byte signature', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const sig = await signer.signMessage('Hello, Cosmos!', pk)

      // 0x + 128 hex chars = 64 bytes (r: 32 + s: 32)
      expect(sig).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce deterministic signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const sig1 = await signer.signMessage('test message', pk)
      const sig2 = await signer.signMessage('test message', pk)
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const sig1 = await signer.signMessage('message 1', pk)
      const sig2 = await signer.signMessage('message 2', pk)
      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const msgBytes = new TextEncoder().encode('Hello')
      const sig = await signer.signMessage(msgBytes, pk)
      expect(sig).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce the same signature for string and equivalent bytes', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const msg = 'Hello, Cosmos!'
      const sig1 = await signer.signMessage(msg, pk)
      const sig2 = await signer.signMessage(new TextEncoder().encode(msg), pk)
      expect(sig1).toBe(sig2)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction with sign doc in data', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: 'cosmos1xyz',
        value: '1000000',
        data: '{"chain_id":"cosmoshub-4","account_number":"0","sequence":"0","fee":{"amount":[{"denom":"uatom","amount":"5000"}],"gas":"200000"},"msgs":[]}',
      }

      const signedTx = await signer.signTransaction(tx, pk)
      // Should be 0x + 128 hex chars (64 bytes signature)
      expect(signedTx).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce deterministic signed transactions', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: 'cosmos1xyz',
        value: '0',
        data: '{"test":"data"}',
      }

      const sig1 = await signer.signTransaction(tx, pk)
      const sig2 = await signer.signTransaction(tx, pk)
      expect(sig1).toBe(sig2)
    })
  })
})
