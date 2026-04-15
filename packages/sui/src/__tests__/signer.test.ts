import { describe, it, expect } from 'vitest'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { hexToBytes } from '@noble/hashes/utils'
import { SuiSigner } from '../signer.js'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SUI_PATH = "m/44'/784'/0'/0'/0'"

describe('SuiSigner', () => {
  const signer = new SuiSigner()

  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic by default', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words.length).toBe(12)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate a valid 24-word mnemonic with 256-bit strength', () => {
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
    it('should derive a 32-byte private key from mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key for the same mnemonic and path', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/784'/1'/0'/0'")
      expect(key1).not.toBe(key2)
    })

    it('should reject non-hardened paths for ED25519', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/784'/0'/0/0"),
      ).rejects.toThrow('hardened')
    })
  })

  describe('getAddress', () => {
    it('should return a valid Sui address (0x + 64 hex chars)', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      const address = signer.getAddress(privateKey)

      // Sui address: 0x + 64 hex characters (32 bytes)
      expect(address).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should return the same address for the same private key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should match the official Sui ED25519 address derivation', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      const keypair = Ed25519Keypair.fromSecretKey(hexToBytes(privateKey.slice(2)))

      expect(signer.getAddress(privateKey)).toBe(keypair.getPublicKey().toSuiAddress())
      expect(signer.getAddress(privateKey)).toBe(
        '0x5e93a736d04fbb25737aa40bee40171ef79f65fae833749e3c089fe7cc2161f1',
      )
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('signMessage', () => {
    it('should sign a string message and return a 64-byte signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      const signature = await signer.signMessage('hello sui', privateKey)

      // ED25519 signature is 64 bytes = 128 hex chars + 0x prefix
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      const msgBytes = new TextEncoder().encode('hello sui')
      const signature = await signer.signMessage(msgBytes, privateKey)

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce the same signature for the same message and key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      const sig1 = await signer.signMessage('test', privateKey)
      const sig2 = await signer.signMessage('test', privateKey)
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      const sig1 = await signer.signMessage('message1', privateKey)
      const sig2 = await signer.signMessage('message2', privateKey)
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('signTransaction', () => {
    it('should sign transaction data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      const address = signer.getAddress(privateKey)

      const tx = {
        from: address,
        to: '0x' + '1'.repeat(64),
        value: '1000000000',
        data: '0x' + '00'.repeat(32),
      }

      const signature = await signer.signTransaction(tx, privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should throw when transaction data is missing', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, SUI_PATH)
      const address = signer.getAddress(privateKey)

      const tx = {
        from: address,
        to: '0x' + '1'.repeat(64),
        value: '1000000000',
      }

      await expect(signer.signTransaction(tx, privateKey)).rejects.toThrow(
        'Transaction data',
      )
    })
  })
})
