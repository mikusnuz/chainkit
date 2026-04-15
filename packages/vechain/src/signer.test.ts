import { describe, it, expect } from 'vitest'
import { VeChainSigner, VECHAIN_HD_PATH } from './signer.js'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('VeChainSigner', () => {
  const signer = new VeChainSigner()

  describe('HD path constant', () => {
    it('should use coin type 818 for VeChain', () => {
      expect(VECHAIN_HD_PATH).toBe("m/44'/818'/0'/0/0")
    })
  })

  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic by default', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words.length).toBe(12)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate a 24-word mnemonic with strength 256', () => {
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
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive different keys for different HD paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/818'/0'/0/1")
      expect(key1).not.toBe(key2)
    })

    it('should derive different keys than Ethereum path', async () => {
      const vechainKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const ethKey = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/0")
      expect(vechainKey).not.toBe(ethKey)
    })
  })

  describe('getAddress', () => {
    it('should derive a valid 0x-prefixed address', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })

    it('should derive the same address for the same private key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const address1 = signer.getAddress(privateKey)
      const address2 = signer.getAddress(privateKey)
      expect(address1).toBe(address2)
    })

    it('should produce a checksummed address', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const address = signer.getAddress(privateKey)
      // Checksummed addresses have a mix of upper and lower case
      expect(address.slice(2)).not.toBe(address.slice(2).toLowerCase())
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })

    it('should derive different address than Ethereum for same mnemonic', async () => {
      const vechainKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const ethKey = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/0")
      const vechainAddr = signer.getAddress(vechainKey)
      const ethAddr = signer.getAddress(ethKey)
      // Different keys should produce different addresses
      expect(vechainAddr).not.toBe(ethAddr)
    })
  })

  describe('signMessage', () => {
    it('should produce a valid signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'hello vechain' })
      // r (64 chars) + s (64 chars) + v (2 chars) = 130 hex chars + 0x prefix
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'hello vechain' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'hello vechain' })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'message one' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'message two' })
      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const msgBytes = new TextEncoder().encode('hello vechain')
      const signature = await signer.signMessage({ privateKey: privateKey, message: msgBytes })
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/)
    })
  })

  describe('signTransaction', () => {
    it('should produce a valid signed transaction hex', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const address = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: address,
          to: '0x7567d83b7b8d80addcb281a71d54fc7b3364ffed',
          value: '1000000000000000000', // 1 VET
          extra: {
            chainTag: 0x27,
            blockRef: '0x00000000aabbccdd',
            expiration: 720,
            gasPriceCoef: 0,
            nonce: '0x1',
          },
          fee: {
            gas: '21000',
          },
        } })

      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      // Should be substantial length (RLP encoded body + 65 byte signature within RLP)
      expect(signedTx.length).toBeGreaterThan(100)
    })

    it('should produce deterministic signatures for same inputs', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const address = signer.getAddress(privateKey)

      const tx = {
        from: address,
        to: '0x7567d83b7b8d80addcb281a71d54fc7b3364ffed',
        value: '1000000000000000000',
        extra: {
          chainTag: 0x27,
          blockRef: '0x00000000aabbccdd',
          expiration: 720,
          gasPriceCoef: 0,
          nonce: '0x1',
        },
        fee: {
          gas: '21000',
        },
      }

      const sig1 = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      const sig2 = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      expect(sig1).toBe(sig2)
    })

    it('should generate random nonce when not provided', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const address = signer.getAddress(privateKey)

      const tx = {
        from: address,
        to: '0x7567d83b7b8d80addcb281a71d54fc7b3364ffed',
        value: '1000000000000000000',
        extra: {
          chainTag: 0x27,
          blockRef: '0x00000000aabbccdd',
          expiration: 720,
          gasPriceCoef: 0,
          // nonce intentionally omitted
        },
        fee: {
          gas: '21000',
        },
      }

      const sig1 = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      const sig2 = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      // Different random nonces should produce different transactions
      expect(sig1).not.toBe(sig2)
    })

    it('should include signature within the RLP structure', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const address = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: address,
          to: '0x7567d83b7b8d80addcb281a71d54fc7b3364ffed',
          value: '0',
          extra: {
            chainTag: 0x27,
            blockRef: '0x00000000aabbccdd',
            expiration: 720,
            gasPriceCoef: 0,
            nonce: '0xdeadbeef',
          },
          fee: {
            gas: '21000',
          },
        } })

      // The signed tx should start with an RLP list prefix
      // RLP list prefix: if total length > 55, first byte is 0xf7 + len_of_len
      // For smaller tx, first byte is 0xc0 + length (0xc0-0xf7 range)
      const txBytes = hexToBytes(signedTx.slice(2))
      const firstByte = txBytes[0]
      // Must be a valid RLP list prefix (>= 0xc0)
      expect(firstByte).toBeGreaterThanOrEqual(0xc0)
    })

    it('should handle zero-value transfers', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const address = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: address,
          to: '0x7567d83b7b8d80addcb281a71d54fc7b3364ffed',
          value: '0',
          extra: {
            chainTag: 0x27,
            blockRef: '0x00000000aabbccdd',
            expiration: 720,
            gasPriceCoef: 0,
            nonce: '0x1',
          },
          fee: {
            gas: '21000',
          },
        } })

      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      expect(signedTx.length).toBeGreaterThan(100)
    })

    it('should handle contract call data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const address = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: address,
          to: '0x7567d83b7b8d80addcb281a71d54fc7b3364ffed',
          value: '0',
          data: '0xa9059cbb0000000000000000000000007567d83b7b8d80addcb281a71d54fc7b3364ffed0000000000000000000000000000000000000000000000000de0b6b3a7640000',
          extra: {
            chainTag: 0x27,
            blockRef: '0x00000000aabbccdd',
            expiration: 720,
            gasPriceCoef: 128,
            nonce: '0xabc123',
          },
          fee: {
            gas: '50000',
          },
        } })

      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      // Contract calls should be longer than simple transfers
      expect(signedTx.length).toBeGreaterThan(200)
    })

    it('should handle dependsOn field', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, VECHAIN_HD_PATH)
      const address = signer.getAddress(privateKey)
      const dependencyTxId = '0x' + 'ab'.repeat(32)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: address,
          to: '0x7567d83b7b8d80addcb281a71d54fc7b3364ffed',
          value: '1000000000000000000',
          extra: {
            chainTag: 0x27,
            blockRef: '0x00000000aabbccdd',
            expiration: 720,
            gasPriceCoef: 0,
            nonce: '0x1',
            dependsOn: dependencyTxId,
          },
          fee: {
            gas: '21000',
          },
        } })

      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      // With dependsOn, the tx should be longer
      expect(signedTx.length).toBeGreaterThan(100)
    })
  })
})
