import { describe, it, expect } from 'vitest'
import { MultiversXSigner, MULTIVERSX_DEFAULT_PATH, pubkeyToBech32, bech32ToPubkey } from '../signer.js'
import * as ed25519 from '@noble/ed25519'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'

describe('MultiversXSigner', () => {
  const signer = new MultiversXSigner()

  // Test mnemonic (DO NOT use in production)
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

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
    it('should return true for a valid mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should return false for an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key from mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, MULTIVERSX_DEFAULT_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key deterministically', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, MULTIVERSX_DEFAULT_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, MULTIVERSX_DEFAULT_PATH)
      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/508'/0'/0'/0'")
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/508'/0'/0'/1'")
      expect(key1).not.toBe(key2)
    })

    it('should reject non-hardened paths', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/508'/0'/0/0"),
      ).rejects.toThrow('hardened')
    })

    it('should reject invalid paths', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, 'invalid'),
      ).rejects.toThrow('Invalid derivation path')
    })
  })

  describe('getAddress', () => {
    it('should return a bech32 address starting with erd1', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, MULTIVERSX_DEFAULT_PATH)
      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^erd1[a-z0-9]{58}$/)
    })

    it('should derive deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, MULTIVERSX_DEFAULT_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should reject invalid private key length', () => {
      expect(() => signer.getAddress('0xdeadbeef')).toThrow('Invalid private key length')
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, MULTIVERSX_DEFAULT_PATH)
      const signature = await signer.signMessage('hello multiversx', privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/) // 64-byte ED25519 signature
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, MULTIVERSX_DEFAULT_PATH)
      const message = new TextEncoder().encode('hello multiversx')
      const signature = await signer.signMessage(message, privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce verifiable signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, MULTIVERSX_DEFAULT_PATH)
      const address = signer.getAddress(privateKey)

      const message = 'test message for verification'
      const signature = await signer.signMessage(message, privateKey)

      // Decode the public key from the address
      const pubkeyBytes = bech32ToPubkey(address)
      const sigBytes = hexToBytes(signature.slice(2))
      const msgBytes = new TextEncoder().encode(message)

      const isValid = ed25519.verify(sigBytes, msgBytes, pubkeyBytes)
      expect(isValid).toBe(true)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, MULTIVERSX_DEFAULT_PATH)
      const sig1 = await signer.signMessage('message 1', privateKey)
      const sig2 = await signer.signMessage('message 2', privateKey)
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction with data field', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, MULTIVERSX_DEFAULT_PATH)
      const address = signer.getAddress(privateKey)

      const txData = new TextEncoder().encode('{"nonce":0,"value":"1000000000000000000","receiver":"erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6gq4hu","sender":"' + address + '","gasPrice":1000000000,"gasLimit":50000,"chainID":"1","version":1}')
      const dataHex = '0x' + bytesToHex(txData)

      const signature = await signer.signTransaction(
        {
          from: address,
          to: 'erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6gq4hu',
          value: '1000000000000000000',
          data: dataHex,
        },
        privateKey,
      )

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should sign a transaction from UnsignedTx fields', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, MULTIVERSX_DEFAULT_PATH)
      const address = signer.getAddress(privateKey)

      const signature = await signer.signTransaction(
        {
          from: address,
          to: 'erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6gq4hu',
          value: '1000000000000000000',
          nonce: 0,
          fee: { gasPrice: '1000000000', gasLimit: '50000' },
          extra: { chainID: '1', version: 1 },
        },
        privateKey,
      )

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should reject invalid private key', async () => {
      await expect(
        signer.signTransaction(
          {
            from: 'erd1test',
            to: 'erd1test2',
            value: '0',
            data: '0xdeadbeef',
          },
          '0xdeadbeef',
        ),
      ).rejects.toThrow('Invalid private key length')
    })
  })
})

describe('bech32 address utilities', () => {
  it('should roundtrip pubkey through bech32 encoding', () => {
    // Create a known 32-byte pubkey
    const pubkey = new Uint8Array(32)
    pubkey.fill(0x01)

    const address = pubkeyToBech32(pubkey)
    expect(address).toMatch(/^erd1/)

    const decoded = bech32ToPubkey(address)
    expect(decoded).toEqual(pubkey)
  })

  it('should reject invalid prefix on decode', () => {
    // Manually create a bech32 string with wrong prefix
    expect(() => bech32ToPubkey('btc1invalidaddress')).toThrow()
  })

  it('should reject invalid pubkey length on encode', () => {
    const shortKey = new Uint8Array(16)
    expect(() => pubkeyToBech32(shortKey)).toThrow('Invalid public key length: expected 32 bytes')
  })
})
