import { describe, it, expect } from 'vitest'
import { MinaSigner } from '../signer.js'

const TEST_MNEMONIC =
  'birth bacon antenna hurry eagle exclude hunt globe arctic clinic trash lens ridge about disease debris fine throw chef entire still erase law elder'

const MINA_HD_PATH = "m/44'/12586'/0'/0/0"

describe('MinaSigner', () => {
  const signer = new MinaSigner()

  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(12)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate a valid 24-word mnemonic with strength 256', () => {
      const mnemonic = signer.generateMnemonic(256)
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(24)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })
  })

  describe('validateMnemonic', () => {
    it('should validate a correct mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic words')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key from mnemonic', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      expect(pk).toBeDefined()
      expect(typeof pk).toBe('string')
      expect(pk.length).toBe(64) // 32 bytes hex
    })

    it('should derive the same key deterministically', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      expect(pk1).toBe(pk2)
    })
  })

  describe('getAddress', () => {
    it('should derive a B62 address from private key', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const address = signer.getAddress(pk)
      expect(address).toBeDefined()
      expect(address.startsWith('B62')).toBe(true)
    })

    it('should derive the same address deterministically', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)
      expect(addr1).toBe(addr2)
    })

    it('should throw on invalid private key length', () => {
      expect(() => signer.getAddress('abcd')).toThrow()
    })
  })

  describe('validateAddress', () => {
    it('should validate a derived address', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const address = signer.getAddress(pk)
      expect(signer.validateAddress(address)).toBe(true)
    })

    it('should reject addresses without B62 prefix', () => {
      expect(signer.validateAddress('0x1234567890abcdef')).toBe(false)
    })

    it('should reject empty string', () => {
      expect(signer.validateAddress('')).toBe(false)
    })

    it('should reject random invalid B62 string', () => {
      expect(signer.validateAddress('B62abc')).toBe(false)
    })
  })

  describe('signMessage', () => {
    it('should sign a message and return JSON with field and scalar', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const result = await signer.signMessage({ privateKey: pk, message: 'Hello Mina' })
      const parsed = JSON.parse(result)
      expect(parsed.field).toBeDefined()
      expect(parsed.scalar).toBeDefined()
      expect(typeof parsed.field).toBe('string')
      expect(typeof parsed.scalar).toBe('string')
    })

    it('should produce deterministic signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: pk, message: 'Hello Mina' })
      const sig2 = await signer.signMessage({ privateKey: pk, message: 'Hello Mina' })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: pk, message: 'Hello' })
      const sig2 = await signer.signMessage({ privateKey: pk, message: 'World' })
      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const msg = new TextEncoder().encode('Hello Mina')
      const result = await signer.signMessage({ privateKey: pk, message: msg })
      const parsed = JSON.parse(result)
      expect(parsed.field).toBeDefined()
      expect(parsed.scalar).toBeDefined()
    })
  })

  describe('signTransaction', () => {
    it('should sign a payment transaction', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const address = signer.getAddress(pk)

      const result = await signer.signTransaction({
        privateKey: pk,
        tx: {
          from: address,
          to: 'B62qjsV6WQwTeEWrNrRRBP6VaaLvQhwWTnFi4WP4LQjGvpfZEumXzx',
          value: '1000000000',
          fee: { fee: '10000000' },
          nonce: 0,
          memo: 'test payment',
        },
      })

      const parsed = JSON.parse(result)
      expect(parsed.signature).toBeDefined()
      expect(parsed.signature.field).toBeDefined()
      expect(parsed.signature.scalar).toBeDefined()
      expect(parsed.payment).toBeDefined()
      expect(parsed.payment.from).toBe(address)
      expect(parsed.payment.to).toBe('B62qjsV6WQwTeEWrNrRRBP6VaaLvQhwWTnFi4WP4LQjGvpfZEumXzx')
      expect(parsed.payment.amount).toBe('1000000000')
    })

    it('should produce deterministic transaction signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const address = signer.getAddress(pk)
      const txParams = {
        privateKey: pk,
        tx: {
          from: address,
          to: 'B62qjsV6WQwTeEWrNrRRBP6VaaLvQhwWTnFi4WP4LQjGvpfZEumXzx',
          value: '1000000000',
          fee: { fee: '10000000' },
          nonce: 0,
        },
      }

      const sig1 = await signer.signTransaction(txParams)
      const sig2 = await signer.signTransaction(txParams)
      expect(sig1).toBe(sig2)
    })
  })
})
