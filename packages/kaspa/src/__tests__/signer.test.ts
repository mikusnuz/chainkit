import { describe, it, expect } from 'vitest'
import { KaspaSigner } from '../signer.js'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const KASPA_PATH = "m/44'/111111'/0'/0/0"

describe('KaspaSigner', () => {
  const signer = new KaspaSigner('mainnet')

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
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      expect(pk).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should produce deterministic keys', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should produce different keys for different paths', async () => {
      const pk0 = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/111111'/0'/0/1")
      expect(pk0).not.toBe(pk1)
    })

    it('should produce different keys for different account indices', async () => {
      const pk0 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/111111'/0'/0/0")
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/111111'/1'/0/0")
      expect(pk0).not.toBe(pk1)
    })
  })

  describe('getAddress', () => {
    it('should return a valid kaspa bech32 address', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const address = signer.getAddress(pk)

      // Kaspa mainnet address starts with 'kaspa1'
      expect(address).toMatch(/^kaspa1[a-z0-9]+$/)
    })

    it('should produce deterministic addresses', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)
      expect(addr1).toBe(addr2)
    })

    it('should produce a testnet address when constructed with testnet', async () => {
      const testnetSigner = new KaspaSigner('testnet')
      const pk = await testnetSigner.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const address = testnetSigner.getAddress(pk)

      expect(address).toMatch(/^kaspatest1/)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })

    it('should produce different addresses for different private keys', async () => {
      const pk0 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/111111'/0'/0/0")
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/111111'/0'/0/1")
      const addr0 = signer.getAddress(pk0)
      const addr1 = signer.getAddress(pk1)
      expect(addr0).not.toBe(addr1)
    })
  })

  describe('signMessage', () => {
    it('should produce a valid 65-byte compact signature', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const sig = await signer.signMessage('Hello, Kaspa!', pk)

      // 0x + 130 hex chars = 65 bytes (recovery: 1 + r: 32 + s: 32)
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce deterministic signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const sig1 = await signer.signMessage('test message', pk)
      const sig2 = await signer.signMessage('test message', pk)
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const sig1 = await signer.signMessage('message 1', pk)
      const sig2 = await signer.signMessage('message 2', pk)
      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const msgBytes = new TextEncoder().encode('Hello')
      const sig = await signer.signMessage(msgBytes, pk)
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce the same signature for string and equivalent bytes', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const msg = 'Hello, Kaspa!'
      const sig1 = await signer.signMessage(msg, pk)
      const sig2 = await signer.signMessage(new TextEncoder().encode(msg), pk)
      expect(sig1).toBe(sig2)
    })

    it('should have a recovery flag byte in range 27-34', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const sig = await signer.signMessage('test', pk)
      const recoveryByte = parseInt(sig.slice(2, 4), 16)
      expect(recoveryByte).toBeGreaterThanOrEqual(27)
      expect(recoveryByte).toBeLessThanOrEqual(34)
    })
  })

  describe('signTransaction', () => {
    it('should sign a simple UTXO transaction', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const address = signer.getAddress(pk)

      const tx = {
        from: address,
        to: address,
        value: '50000',
        extra: {
          inputs: [
            {
              txHash: 'a'.repeat(64),
              outputIndex: 0,
              value: '100000',
            },
          ],
          outputs: [
            {
              address: address,
              value: '50000',
            },
            {
              address: address,
              value: '49000',
            },
          ],
        },
      }

      const signedTx = await signer.signTransaction(tx, pk)
      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      expect(signedTx.length).toBeGreaterThan(10)
    })

    it('should produce deterministic signed transactions', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const address = signer.getAddress(pk)

      const tx = {
        from: address,
        to: address,
        value: '10000',
        extra: {
          inputs: [
            {
              txHash: 'b'.repeat(64),
              outputIndex: 0,
              value: '20000',
            },
          ],
          outputs: [
            {
              address: address,
              value: '10000',
            },
          ],
        },
      }

      const sig1 = await signer.signTransaction(tx, pk)
      const sig2 = await signer.signTransaction(tx, pk)
      expect(sig1).toBe(sig2)
    })

    it('should throw if no inputs are provided', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const address = signer.getAddress(pk)

      const tx = {
        from: address,
        to: address,
        value: '10000',
        extra: {
          inputs: [],
          outputs: [{ address: address, value: '10000' }],
        },
      }

      await expect(signer.signTransaction(tx, pk)).rejects.toThrow('at least one input')
    })

    it('should throw if no outputs are provided', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const address = signer.getAddress(pk)

      const tx = {
        from: address,
        to: address,
        value: '10000',
        extra: {
          inputs: [{ txHash: 'c'.repeat(64), outputIndex: 0, value: '20000' }],
          outputs: [],
        },
      }

      await expect(signer.signTransaction(tx, pk)).rejects.toThrow('at least one output')
    })

    it('should handle multiple inputs', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, KASPA_PATH)
      const address = signer.getAddress(pk)

      const tx = {
        from: address,
        to: address,
        value: '50000',
        extra: {
          inputs: [
            { txHash: 'a'.repeat(64), outputIndex: 0, value: '30000' },
            { txHash: 'b'.repeat(64), outputIndex: 1, value: '30000' },
          ],
          outputs: [
            { address: address, value: '50000' },
            { address: address, value: '9000' },
          ],
        },
      }

      const signedTx = await signer.signTransaction(tx, pk)
      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      expect(signedTx.length).toBeGreaterThan(200)
    })
  })
})
