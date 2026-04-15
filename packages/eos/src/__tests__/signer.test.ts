import { describe, it, expect } from 'vitest'
import { EosSigner, publicKeyToEosFormat, eosFormatToPublicKey, nameToUint64Bytes, uint64BytesToName, EOS_HD_PATH } from '../index.js'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import * as secp256k1 from '@noble/secp256k1'

describe('EosSigner', () => {
  const signer = new EosSigner()

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
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should return false for an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key from mnemonic using EOS HD path', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const privateKey = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)

      expect(privateKey).toBeDefined()
      expect(typeof privateKey).toBe('string')
      // Should be 64 hex chars (32 bytes)
      const clean = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
      expect(clean.length).toBe(64)
    })

    it('should derive deterministic keys', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const pk1 = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)
      const pk2 = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should derive different keys for different paths', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const pk1 = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)
      const pk2 = await signer.derivePrivateKey(mnemonic, "m/44'/194'/0'/0/1")
      expect(pk1).not.toBe(pk2)
    })
  })

  describe('getAddress', () => {
    it('should return an EOS-format public key', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const privateKey = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)
      const address = signer.getAddress(privateKey)

      expect(address).toMatch(/^EOS[1-9A-HJ-NP-Za-km-z]+$/)
    })

    it('should return deterministic address for same private key', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const privateKey = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('abcd')).toThrow('Invalid private key length')
    })

    it('should produce a valid public key that can be decoded back', async () => {
      const mnemonic = signer.generateMnemonic()
      const privateKey = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)
      const address = signer.getAddress(privateKey)

      // Decode back
      const pubKeyBytes = eosFormatToPublicKey(address)
      expect(pubKeyBytes.length).toBe(33)

      // Re-encode should match
      const reEncoded = publicKeyToEosFormat(pubKeyBytes)
      expect(reEncoded).toBe(address)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction and return SIG_K1_ format', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const privateKey = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)

      const signature = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: 'testaccount1',
          to: 'testaccount2',
          value: '10000', // 1.0000 EOS in smallest unit
          data: '00',
          extra: {
            chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
            expiration: 1700000000,
            refBlockNum: 100,
            refBlockPrefix: 200,
            account: 'eosio.token',
            actionName: 'transfer',
            permission: 'active',
          },
        } })

      expect(signature).toMatch(/^SIG_K1_[1-9A-HJ-NP-Za-km-z]+$/)
    })

    it('should produce deterministic signatures for same input', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const privateKey = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)

      const tx = {
        from: 'testaccount1',
        to: 'testaccount2',
        value: '10000',
        data: '00',
        extra: {
          chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
          expiration: 1700000000,
          refBlockNum: 100,
          refBlockPrefix: 200,
        },
      }

      const sig1 = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      const sig2 = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      expect(sig1).toBe(sig2)
    })

    it('should produce SIG_K1_ signatures with valid checksum (data + K1 order)', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const privateKey = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)

      const signature = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: 'testaccount1',
          to: 'testaccount2',
          value: '10000',
          data: '00',
          extra: {
            chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
            expiration: 1700000000,
            refBlockNum: 100,
            refBlockPrefix: 200,
          },
        } })

      // Decode the SIG_K1_ signature and verify the checksum uses
      // the EOSIO fc convention: ripemd160(sigBytes + "K1")
      const { base58 } = await import('@scure/base')
      const { ripemd160 } = await import('@noble/hashes/ripemd160')

      const payload = base58.decode(signature.slice(7))
      expect(payload.length).toBe(69) // 65 sig + 4 checksum

      const sigBytes = payload.slice(0, 65)
      const checksum = payload.slice(65, 69)

      // Verify checksum: ripemd160(sigBytes + "K1"), first 4 bytes
      const checksumInput = new Uint8Array(65 + 2)
      checksumInput.set(sigBytes, 0)
      checksumInput[65] = 0x4b // 'K'
      checksumInput[66] = 0x31 // '1'
      const expectedChecksum = ripemd160(checksumInput).slice(0, 4)
      expect(bytesToHex(checksum)).toBe(bytesToHex(expectedChecksum))
    })

    it('should throw without chainId', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const privateKey = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)

      await expect(
        signer.signTransaction({ privateKey: privateKey, tx: { from: 'test', to: 'test2', value: '1' } }),
      ).rejects.toThrow('Chain ID is required')
    })
  })

  describe('signMessage', () => {
    it('should sign a string message and return SIG_K1_ format', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const privateKey = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)

      const signature = await signer.signMessage({ privateKey: privateKey, message: 'Hello EOS' })
      expect(signature).toMatch(/^SIG_K1_[1-9A-HJ-NP-Za-km-z]+$/)
    })

    it('should sign Uint8Array message', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const privateKey = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)

      const msgBytes = new TextEncoder().encode('Hello EOS')
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'Hello EOS' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: msgBytes })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const privateKey = await signer.derivePrivateKey(mnemonic, EOS_HD_PATH)

      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'message1' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'message2' })
      expect(sig1).not.toBe(sig2)
    })
  })
})

describe('EOS name encoding', () => {
  it('should encode and decode "eosio"', () => {
    const encoded = nameToUint64Bytes('eosio')
    const decoded = uint64BytesToName(encoded)
    expect(decoded).toBe('eosio')
  })

  it('should encode and decode "eosio.token"', () => {
    const encoded = nameToUint64Bytes('eosio.token')
    const decoded = uint64BytesToName(encoded)
    expect(decoded).toBe('eosio.token')
  })

  it('should encode and decode "testaccount1"', () => {
    const encoded = nameToUint64Bytes('testaccount1')
    const decoded = uint64BytesToName(encoded)
    expect(decoded).toBe('testaccount1')
  })

  it('should encode and decode single character names', () => {
    const encoded = nameToUint64Bytes('a')
    const decoded = uint64BytesToName(encoded)
    expect(decoded).toBe('a')
  })

  it('should handle names with dots', () => {
    const encoded = nameToUint64Bytes('my.account')
    const decoded = uint64BytesToName(encoded)
    expect(decoded).toBe('my.account')
  })

  it('should throw for invalid characters', () => {
    expect(() => nameToUint64Bytes('INVALID')).toThrow('Invalid character')
  })
})

describe('EOS public key format', () => {
  it('should encode and decode a public key', () => {
    // Generate a key pair
    const privKey = hexToBytes('0000000000000000000000000000000000000000000000000000000000000001')
    const pubKey = secp256k1.getPublicKey(privKey, true)

    const eosKey = publicKeyToEosFormat(pubKey)
    expect(eosKey).toMatch(/^EOS/)

    const decoded = eosFormatToPublicKey(eosKey)
    expect(bytesToHex(decoded)).toBe(bytesToHex(pubKey))
  })

  it('should reject non-EOS prefixed keys', () => {
    expect(() => eosFormatToPublicKey('BTC1234567890')).toThrow('must start with "EOS"')
  })

  it('should reject keys with invalid checksum', () => {
    const privKey = hexToBytes('0000000000000000000000000000000000000000000000000000000000000001')
    const pubKey = secp256k1.getPublicKey(privKey, true)
    const eosKey = publicKeyToEosFormat(pubKey)

    // Corrupt the key
    const corrupted = eosKey.slice(0, -2) + 'zz'
    expect(() => eosFormatToPublicKey(corrupted)).toThrow()
  })

  it('should reject non-33-byte input', () => {
    expect(() => publicKeyToEosFormat(new Uint8Array(32))).toThrow('Expected 33-byte')
  })
})
