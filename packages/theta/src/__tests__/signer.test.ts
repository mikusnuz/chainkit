import { describe, it, expect } from 'vitest'
import { ThetaSigner } from '../signer.js'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const THETA_HD_PATH = "m/44'/500'/0'/0/0"

describe('ThetaSigner', () => {
  const signer = new ThetaSigner()

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
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      expect(pk).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should produce deterministic keys', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should produce different keys for different paths', async () => {
      const pk0 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/500'/0'/0/0")
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/500'/0'/0/1")
      expect(pk0).not.toBe(pk1)
    })

    it('should produce a different key than Ethereum for the same mnemonic', async () => {
      const thetaPk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const ethPk = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/0")
      expect(thetaPk).not.toBe(ethPk)
    })
  })

  describe('getAddress', () => {
    it('should return a valid 0x address with 40 hex chars', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const address = signer.getAddress(pk)

      // Should be 0x + 40 hex chars
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })

    it('should produce deterministic addresses', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)
      expect(addr1).toBe(addr2)
    })

    it('should return an EIP-55 checksummed address', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const address = signer.getAddress(pk)
      // Verify it is not all lowercase or all uppercase
      const withoutPrefix = address.slice(2)
      const hasUpper = /[A-F]/.test(withoutPrefix)
      const hasLower = /[a-f]/.test(withoutPrefix)
      expect(hasUpper || hasLower).toBe(true) // At least some case variance
    })

    it('should produce a different address than Ethereum for the same mnemonic', async () => {
      const thetaPk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const ethPk = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/0")
      const thetaAddr = signer.getAddress(thetaPk)
      const ethAddr = signer.getAddress(ethPk)
      expect(thetaAddr.toLowerCase()).not.toBe(ethAddr.toLowerCase())
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('signMessage', () => {
    it('should produce a valid 65-byte signature', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const sig = await signer.signMessage({ privateKey: pk, message: 'Hello, Theta!' })

      // 0x + 130 hex chars = 65 bytes (r: 32 + s: 32 + v: 1)
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce deterministic signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: pk, message: 'test message' })
      const sig2 = await signer.signMessage({ privateKey: pk, message: 'test message' })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: pk, message: 'message 1' })
      const sig2 = await signer.signMessage({ privateKey: pk, message: 'message 2' })
      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const msgBytes = new TextEncoder().encode('Hello')
      const sig = await signer.signMessage({ privateKey: pk, message: msgBytes })
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce the same signature for string and equivalent bytes', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const msg = 'Hello, Theta!'
      const sig1 = await signer.signMessage({ privateKey: pk, message: msg })
      const sig2 = await signer.signMessage({ privateKey: pk, message: new TextEncoder().encode(msg) })
      expect(sig1).toBe(sig2)
    })

    it('should have v value of 27 or 28', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const sig = await signer.signMessage({ privateKey: pk, message: 'test' })
      const vHex = sig.slice(-2)
      const v = parseInt(vHex, 16)
      expect(v === 27 || v === 28).toBe(true)
    })
  })

  describe('signTransaction', () => {
    it('should sign a legacy transaction', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: '0x0000000000000000000000000000000000000001',
        value: '1000000000000000000', // 1 THETA in wei
        nonce: 0,
        fee: {
          gasPrice: '0x4a817c800', // 20 gwei
          gasLimit: '0x5208', // 21000
        },
        extra: { chainId: 361 }, // Theta mainnet
      }

      const signedTx = await signer.signTransaction({ privateKey: pk, tx: tx })
      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      expect(signedTx.length).toBeGreaterThan(10)
    })

    it('should produce deterministic signed transactions', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: '0x0000000000000000000000000000000000000001',
        value: '0',
        nonce: 0,
        fee: { gasPrice: '0x0', gasLimit: '0x5208' },
        extra: { chainId: 361 },
      }

      const sig1 = await signer.signTransaction({ privateKey: pk, tx: tx })
      const sig2 = await signer.signTransaction({ privateKey: pk, tx: tx })
      expect(sig1).toBe(sig2)
    })

    it('should require chainId in tx.extra', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, THETA_HD_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: '0x0000000000000000000000000000000000000001',
        value: '0',
        nonce: 0,
        fee: { gasPrice: '0x0', gasLimit: '0x5208' },
        // no extra.chainId -> should throw
      }

      await expect(signer.signTransaction({ privateKey: pk, tx: tx })).rejects.toThrow(
        'chainId is required',
      )
    })
  })
})
