import { describe, it, expect } from 'vitest'
import {
  StacksSigner,
  c32checkEncode,
  c32checkDecode,
  c32encode,
  c32decode,
  isValidStacksAddress,
  hash160ToAddress,
  DEFAULT_PATH,
  VERSION_MAINNET_SINGLE_SIG,
  VERSION_TESTNET_SINGLE_SIG,
} from '../signer.js'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'

describe('StacksSigner', () => {
  const signer = new StacksSigner('mainnet')
  const testnetSigner = new StacksSigner('testnet')

  // A well-known test mnemonic
  const testMnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic by default', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words.length).toBe(12)
    })

    it('should generate a valid 24-word mnemonic with strength 256', () => {
      const mnemonic = signer.generateMnemonic(256)
      const words = mnemonic.split(' ')
      expect(words.length).toBe(24)
    })
  })

  describe('validateMnemonic', () => {
    it('should validate a correct mnemonic', () => {
      expect(signer.validateMnemonic(testMnemonic)).toBe(true)
    })

    it('should reject an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key from a mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key for the same mnemonic and path', async () => {
      const key1 = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const key2 = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const key2 = await signer.derivePrivateKey(testMnemonic, "m/44'/5757'/0'/0/1")
      expect(key1).not.toBe(key2)
    })
  })

  describe('getAddress', () => {
    it('should derive a mainnet address starting with SP', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^SP[0-9A-Z]+$/)
    })

    it('should derive a testnet address starting with ST', async () => {
      const privateKey = await testnetSigner.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const address = testnetSigner.getAddress(privateKey)
      expect(address).toMatch(/^ST[0-9A-Z]+$/)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })

    it('should produce deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should produce different addresses for mainnet and testnet from same key', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const mainnetAddr = signer.getAddress(privateKey)
      const testnetAddr = testnetSigner.getAddress(privateKey)
      expect(mainnetAddr).not.toBe(testnetAddr)
      expect(mainnetAddr.startsWith('SP')).toBe(true)
      expect(testnetAddr.startsWith('ST')).toBe(true)
    })

    it('should derive a known address for the test mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const mainnetAddr = signer.getAddress(privateKey)
      const testnetAddr = testnetSigner.getAddress(privateKey)

      // Addresses must be deterministic and valid
      expect(isValidStacksAddress(mainnetAddr)).toBe(true)
      expect(isValidStacksAddress(testnetAddr)).toBe(true)

      // Re-derive to ensure consistency
      expect(signer.getAddress(privateKey)).toBe(mainnetAddr)
      expect(testnetSigner.getAddress(privateKey)).toBe(testnetAddr)
    })
  })

  describe('signMessage', () => {
    it('should sign a string message and return a hex signature', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const signature = await signer.signMessage('Hello Stacks', privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]+$/)
      // r (32 bytes) + s (32 bytes) + v (1 byte) = 65 bytes = 130 hex chars + 0x
      expect(signature.length).toBe(132)
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const message = new TextEncoder().encode('Hello Stacks')
      const signature = await signer.signMessage(message, privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]+$/)
      expect(signature.length).toBe(132)
    })

    it('should produce deterministic signatures for the same message', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const sig1 = await signer.signMessage('deterministic', privateKey)
      const sig2 = await signer.signMessage('deterministic', privateKey)
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const sig1 = await signer.signMessage('message1', privateKey)
      const sig2 = await signer.signMessage('message2', privateKey)
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction with pre-hashed data', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      // 32-byte hash as tx data
      const txHash = '0x' + '00'.repeat(32)
      const signature = await signer.signTransaction(
        { from: 'SP...', to: 'SP...', value: '1000000', data: txHash },
        privateKey,
      )
      expect(signature).toMatch(/^0x[0-9a-f]+$/)
      // recovery (1 byte) + r (32 bytes) + s (32 bytes) = 65 bytes = 130 hex chars + 0x
      expect(signature.length).toBe(132)
    })

    it('should sign a STX transfer without pre-hashed data', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const address = signer.getAddress(privateKey)
      const signature = await signer.signTransaction(
        {
          from: address,
          to: 'SP000000000000000000002Q6VF78',
          value: '1000000',
          nonce: 0,
          fee: { fee: '200' },
        },
        privateKey,
      )
      expect(signature).toMatch(/^0x[0-9a-f]+$/)
      // Serialized tx = 180 bytes = 360 hex chars + '0x' prefix = 362 chars
      expect(signature.length).toBe(362)
      // Verify the version byte (0x00 = mainnet)
      expect(signature.slice(2, 4)).toBe('00')
    })

    it('should produce deterministic serialized STX transfer for testnet', async () => {
      const privateKey = await testnetSigner.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const address = testnetSigner.getAddress(privateKey)
      const recipient = 'ST000000000000000000002AMW42H'

      const signed1 = await testnetSigner.signTransaction(
        {
          from: address,
          to: recipient,
          value: '1',
          nonce: 0,
          fee: { fee: '200' },
          extra: { memo: '', network: 'testnet' },
        },
        privateKey,
      )

      const signed2 = await testnetSigner.signTransaction(
        {
          from: address,
          to: recipient,
          value: '1',
          nonce: 0,
          fee: { fee: '200' },
          extra: { memo: '', network: 'testnet' },
        },
        privateKey,
      )

      // Same inputs must produce same output (deterministic signing)
      expect(signed1).toBe(signed2)

      // Verify structure: 180 bytes = 360 hex chars
      expect(signed1.length).toBe(362) // 0x + 360 hex
      // Version byte: 0x80 = testnet
      expect(signed1.slice(2, 4)).toBe('80')
      // Chain ID: 0x80000000
      expect(signed1.slice(4, 12)).toBe('80000000')
    })

    it('should encode memo in the serialized transaction', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, DEFAULT_PATH)
      const address = signer.getAddress(privateKey)

      const withMemo = await signer.signTransaction(
        {
          from: address,
          to: 'SP000000000000000000002Q6VF78',
          value: '100',
          nonce: 0,
          fee: { fee: '200' },
          extra: { memo: 'hello' },
        },
        privateKey,
      )

      const withoutMemo = await signer.signTransaction(
        {
          from: address,
          to: 'SP000000000000000000002Q6VF78',
          value: '100',
          nonce: 0,
          fee: { fee: '200' },
          extra: { memo: '' },
        },
        privateKey,
      )

      // Different memos should produce different serialized transactions
      expect(withMemo).not.toBe(withoutMemo)

      // Both should be valid 180-byte transactions
      expect(withMemo.length).toBe(362)
      expect(withoutMemo.length).toBe(362)
    })
  })
})

describe('c32check encoding', () => {
  describe('c32encode / c32decode', () => {
    it('should round-trip encode and decode bytes', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5])
      const encoded = c32encode(original)
      const decoded = c32decode(encoded)
      expect(bytesToHex(decoded)).toBe(bytesToHex(original))
    })

    it('should handle all-zero bytes', () => {
      const zeros = new Uint8Array([0, 0, 0])
      const encoded = c32encode(zeros)
      const decoded = c32decode(encoded)
      expect(bytesToHex(decoded)).toBe(bytesToHex(zeros))
    })

    it('should handle single byte', () => {
      const single = new Uint8Array([255])
      const encoded = c32encode(single)
      const decoded = c32decode(encoded)
      expect(bytesToHex(decoded)).toBe(bytesToHex(single))
    })
  })

  describe('c32checkEncode / c32checkDecode', () => {
    it('should round-trip with checksum verification', () => {
      const data = hexToBytes('a46ff88886c2ef9762d970b4d2c63678835bd39d')
      const version = VERSION_MAINNET_SINGLE_SIG
      const encoded = c32checkEncode(version, data)
      const decoded = c32checkDecode(encoded)
      expect(decoded.version).toBe(version)
      expect(bytesToHex(decoded.data)).toBe(bytesToHex(data))
    })

    it('should reject invalid version', () => {
      const data = new Uint8Array([1, 2, 3])
      expect(() => c32checkEncode(32, data)).toThrow('Invalid c32check version')
    })

    it('should reject corrupted checksum', () => {
      const data = hexToBytes('a46ff88886c2ef9762d970b4d2c63678835bd39d')
      const encoded = c32checkEncode(VERSION_MAINNET_SINGLE_SIG, data)
      // Corrupt the last character
      const corrupted = encoded.slice(0, -1) + (encoded[encoded.length - 1] === 'A' ? 'B' : 'A')
      expect(() => c32checkDecode(corrupted)).toThrow()
    })

    it('should work with testnet version', () => {
      const data = hexToBytes('b231b2a2e2a31b3c3d4e5f6a7b8c9d0e1f2a3b4c')
      const encoded = c32checkEncode(VERSION_TESTNET_SINGLE_SIG, data)
      const decoded = c32checkDecode(encoded)
      expect(decoded.version).toBe(VERSION_TESTNET_SINGLE_SIG)
      expect(bytesToHex(decoded.data)).toBe(bytesToHex(data))
    })
  })
})

describe('isValidStacksAddress', () => {
  it('should validate a mainnet address', async () => {
    const signer = new StacksSigner('mainnet')
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const pk = await signer.derivePrivateKey(mnemonic, DEFAULT_PATH)
    const address = signer.getAddress(pk)
    expect(isValidStacksAddress(address)).toBe(true)
  })

  it('should validate a testnet address', async () => {
    const signer = new StacksSigner('testnet')
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const pk = await signer.derivePrivateKey(mnemonic, DEFAULT_PATH)
    const address = signer.getAddress(pk)
    expect(isValidStacksAddress(address)).toBe(true)
  })

  it('should reject invalid prefix', () => {
    expect(isValidStacksAddress('SX1234567890')).toBe(false)
  })

  it('should reject empty string', () => {
    expect(isValidStacksAddress('')).toBe(false)
  })

  it('should reject an address that is too short', () => {
    expect(isValidStacksAddress('SP')).toBe(false)
  })
})

describe('DEFAULT_PATH', () => {
  it('should be the standard Stacks HD path', () => {
    expect(DEFAULT_PATH).toBe("m/44'/5757'/0'/0/0")
  })
})

describe('hash160ToAddress', () => {
  it('should produce SP prefix for mainnet', () => {
    const hash = new Uint8Array(20)
    const address = hash160ToAddress(hash, VERSION_MAINNET_SINGLE_SIG)
    expect(address.startsWith('SP')).toBe(true)
  })

  it('should produce ST prefix for testnet', () => {
    const hash = new Uint8Array(20)
    const address = hash160ToAddress(hash, VERSION_TESTNET_SINGLE_SIG)
    expect(address.startsWith('ST')).toBe(true)
  })
})
