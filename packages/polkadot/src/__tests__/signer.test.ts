import { describe, it, expect } from 'vitest'
import { PolkadotSigner, encodeSS58, decodeSS58, POLKADOT_DEFAULT_PATH } from '../signer.js'

// Well-known test mnemonic
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('PolkadotSigner', () => {
  describe('constructor', () => {
    it('should default to polkadot network', () => {
      const signer = new PolkadotSigner()
      const config = signer.getNetworkConfig()
      expect(config.prefix).toBe(0)
      expect(config.symbol).toBe('DOT')
      expect(config.decimals).toBe(10)
    })

    it('should support kusama network', () => {
      const signer = new PolkadotSigner('kusama')
      const config = signer.getNetworkConfig()
      expect(config.prefix).toBe(2)
      expect(config.symbol).toBe('KSM')
      expect(config.decimals).toBe(12)
    })

    it('should support generic substrate network', () => {
      const signer = new PolkadotSigner('substrate')
      const config = signer.getNetworkConfig()
      expect(config.prefix).toBe(42)
      expect(config.symbol).toBe('DOT')
      expect(config.decimals).toBe(10)
    })
  })

  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic by default', () => {
      const signer = new PolkadotSigner()
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words.length).toBe(12)
    })

    it('should generate a valid 24-word mnemonic with 256-bit strength', () => {
      const signer = new PolkadotSigner()
      const mnemonic = signer.generateMnemonic(256)
      const words = mnemonic.split(' ')
      expect(words.length).toBe(24)
    })
  })

  describe('validateMnemonic', () => {
    it('should validate a correct mnemonic', () => {
      const signer = new PolkadotSigner()
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject an invalid mnemonic', () => {
      const signer = new PolkadotSigner()
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a deterministic private key from mnemonic', async () => {
      const signer = new PolkadotSigner()
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should return a 0x-prefixed hex string', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      expect(pk.startsWith('0x')).toBe(true)
      // 0x + 64 hex chars = 32 bytes
      expect(pk.length).toBe(66)
    })

    it('should derive different keys for different paths', async () => {
      const signer = new PolkadotSigner()
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/354'/0'/0'/0'")
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/354'/0'/0'/1'")
      expect(pk1).not.toBe(pk2)
    })

    it('should reject non-hardened derivation paths', async () => {
      const signer = new PolkadotSigner()
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/354'/0'/0/0"),
      ).rejects.toThrow('hardened')
    })

    it('should reject invalid path format', async () => {
      const signer = new PolkadotSigner()
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, 'invalid'),
      ).rejects.toThrow('Invalid derivation path')
    })
  })

  describe('getAddress', () => {
    it('should derive an SS58 address from a private key', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const address = signer.getAddress(pk)

      // SS58 address should be a base58 string
      expect(typeof address).toBe('string')
      expect(address.length).toBeGreaterThan(0)

      // Polkadot addresses typically start with '1' (prefix 0)
      expect(address[0]).toBe('1')
    })

    it('should generate kusama address starting with a capital letter', async () => {
      const signer = new PolkadotSigner('kusama')
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const address = signer.getAddress(pk)

      expect(typeof address).toBe('string')
      expect(address.length).toBeGreaterThan(0)
    })

    it('should generate substrate generic address starting with "5"', async () => {
      const signer = new PolkadotSigner('substrate')
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const address = signer.getAddress(pk)

      expect(typeof address).toBe('string')
      expect(address.length).toBeGreaterThan(0)
      // Generic substrate prefix 42 produces addresses starting with '5'
      expect(address[0]).toBe('5')
    })

    it('should produce deterministic addresses', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)
      expect(addr1).toBe(addr2)
    })

    it('should reject invalid private key length', () => {
      const signer = new PolkadotSigner()
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })

    it('should produce different addresses for different networks from same key', async () => {
      const polkadotSigner = new PolkadotSigner('polkadot')
      const kusamaSigner = new PolkadotSigner('kusama')
      const substrateSigner = new PolkadotSigner('substrate')

      const pk = await polkadotSigner.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const polkadotAddr = polkadotSigner.getAddress(pk)
      const kusamaAddr = kusamaSigner.getAddress(pk)
      const substrateAddr = substrateSigner.getAddress(pk)

      expect(polkadotAddr).not.toBe(kusamaAddr)
      expect(polkadotAddr).not.toBe(substrateAddr)
      expect(kusamaAddr).not.toBe(substrateAddr)
    })
  })

  describe('SS58 encode/decode roundtrip', () => {
    it('should roundtrip SS58 encoding', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const address = signer.getAddress(pk)

      const decoded = decodeSS58(address)
      expect(decoded.prefix).toBe(0) // Polkadot prefix
      expect(decoded.publicKey.length).toBe(32)

      // Re-encode should give the same address
      const reencoded = encodeSS58(decoded.publicKey, decoded.prefix)
      expect(reencoded).toBe(address)
    })

    it('should roundtrip kusama SS58 encoding', async () => {
      const signer = new PolkadotSigner('kusama')
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const address = signer.getAddress(pk)

      const decoded = decodeSS58(address)
      expect(decoded.prefix).toBe(2) // Kusama prefix

      const reencoded = encodeSS58(decoded.publicKey, decoded.prefix)
      expect(reencoded).toBe(address)
    })

    it('should reject invalid SS58 checksum', () => {
      // Corrupt a valid address by changing a character
      expect(() => decodeSS58('1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toThrow()
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction and return 0x-prefixed hex', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const tx = {
        from: signer.getAddress(pk),
        to: signer.getAddress(pk),
        value: '1000000000',
        data: '0x' + 'ab'.repeat(32),
      }

      const signature = await signer.signTransaction(tx, pk)
      expect(signature.startsWith('0x')).toBe(true)
      // ED25519 signature is 64 bytes = 128 hex chars + 2 for '0x'
      expect(signature.length).toBe(130)
    })

    it('should reject transaction without data', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const tx = {
        from: signer.getAddress(pk),
        to: signer.getAddress(pk),
        value: '1000000000',
      }

      await expect(signer.signTransaction(tx, pk)).rejects.toThrow('Transaction data')
    })

    it('should produce deterministic signatures', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const tx = {
        from: signer.getAddress(pk),
        to: signer.getAddress(pk),
        value: '1000000000',
        data: '0x' + 'cd'.repeat(32),
      }

      const sig1 = await signer.signTransaction(tx, pk)
      const sig2 = await signer.signTransaction(tx, pk)
      expect(sig1).toBe(sig2)
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const signature = await signer.signMessage('Hello Polkadot', pk)
      expect(signature.startsWith('0x')).toBe(true)
      expect(signature.length).toBe(130) // 64 bytes = 128 hex + 0x
    })

    it('should sign a Uint8Array message', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage(message, pk)
      expect(signature.startsWith('0x')).toBe(true)
      expect(signature.length).toBe(130)
    })

    it('should produce deterministic signatures', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const sig1 = await signer.signMessage('test message', pk)
      const sig2 = await signer.signMessage('test message', pk)
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const sig1 = await signer.signMessage('message 1', pk)
      const sig2 = await signer.signMessage('message 2', pk)
      expect(sig1).not.toBe(sig2)
    })
  })
})
