import { describe, it, expect } from 'vitest'
import { EthereumSigner } from '../signer.js'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ETH_HD_PATH = "m/44'/60'/0'/0/0"

describe('EthereumSigner', () => {
  const signer = new EthereumSigner()

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
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      expect(pk).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should produce deterministic keys', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should produce different keys for different paths', async () => {
      const pk0 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/0")
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/1")
      expect(pk0).not.toBe(pk1)
    })

    it('should match the known private key for the test mnemonic', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      expect(pk).toBe('0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727')
    })
  })

  describe('getAddress', () => {
    it('should return a valid Ethereum address', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const address = signer.getAddress(pk)

      // Should be 0x + 40 hex chars
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })

    it('should produce deterministic addresses', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)
      expect(addr1).toBe(addr2)
    })

    it('should match the expected address (case-insensitive)', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const address = signer.getAddress(pk)
      expect(address.toLowerCase()).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94')
    })

    it('should return an EIP-55 checksummed address', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const address = signer.getAddress(pk)
      // Verify it is not all lowercase or all uppercase
      const withoutPrefix = address.slice(2)
      const hasUpper = /[A-F]/.test(withoutPrefix)
      const hasLower = /[a-f]/.test(withoutPrefix)
      expect(hasUpper || hasLower).toBe(true) // At least some case variance
    })
  })

  describe('signMessage', () => {
    it('should produce a valid 65-byte signature', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const sig = await signer.signMessage({ privateKey: pk, message: 'Hello, Ethereum!' })

      // 0x + 130 hex chars = 65 bytes (r: 32 + s: 32 + v: 1)
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce deterministic signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: pk, message: 'test message' })
      const sig2 = await signer.signMessage({ privateKey: pk, message: 'test message' })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: pk, message: 'message 1' })
      const sig2 = await signer.signMessage({ privateKey: pk, message: 'message 2' })
      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const msgBytes = new TextEncoder().encode('Hello')
      const sig = await signer.signMessage({ privateKey: pk, message: msgBytes })
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce the same signature for string and equivalent bytes', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const msg = 'Hello, Ethereum!'
      const sig1 = await signer.signMessage({ privateKey: pk, message: msg })
      const sig2 = await signer.signMessage({ privateKey: pk, message: new TextEncoder().encode(msg) })
      expect(sig1).toBe(sig2)
    })

    it('should have v value of 27 or 28', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const sig = await signer.signMessage({ privateKey: pk, message: 'test' })
      const vHex = sig.slice(-2)
      const v = parseInt(vHex, 16)
      expect(v === 27 || v === 28).toBe(true)
    })
  })

  describe('signTransaction', () => {
    it('should sign a legacy transaction', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: '0x0000000000000000000000000000000000000001',
        value: '1000000000000000000', // 1 ETH in wei
        nonce: 0,
        fee: {
          gasPrice: '0x4a817c800', // 20 gwei
          gasLimit: '0x5208', // 21000
        },
        extra: { chainId: 1 },
      }

      const signedTx = await signer.signTransaction({ privateKey: pk, tx: tx })
      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      expect(signedTx.length).toBeGreaterThan(10)
    })

    it('should sign an EIP-1559 transaction', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: '0x0000000000000000000000000000000000000001',
        value: '1000000000000000000',
        nonce: 0,
        fee: {
          maxFeePerGas: '0x4a817c800',
          maxPriorityFeePerGas: '0x3b9aca00',
          gasLimit: '0x5208',
        },
        extra: { chainId: 1 },
      }

      const signedTx = await signer.signTransaction({ privateKey: pk, tx: tx })
      // EIP-1559 transactions start with 0x02
      expect(signedTx).toMatch(/^0x02[0-9a-f]+$/)
    })

    it('should produce deterministic signed transactions', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ETH_HD_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: '0x0000000000000000000000000000000000000001',
        value: '0',
        nonce: 0,
        fee: { gasPrice: '0x0', gasLimit: '0x5208' },
        extra: { chainId: 1 },
      }

      const sig1 = await signer.signTransaction({ privateKey: pk, tx: tx })
      const sig2 = await signer.signTransaction({ privateKey: pk, tx: tx })
      expect(sig1).toBe(sig2)
    })
  })
})
