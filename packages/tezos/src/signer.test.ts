import { describe, it, expect } from 'vitest'
import {
  TezosSigner,
  zarithEncode,
  decodeBlockHash,
  decodeTz1Address,
  encodeDestination,
  forgeTransaction,
} from './signer.js'
import { bytesToHex } from '@noble/hashes/utils'

describe('TezosSigner', () => {
  const signer = new TezosSigner()

  // Known test mnemonic
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  const TEZOS_PATH = "m/44'/1729'/0'/0'"

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
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key for the same mnemonic and path', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/1729'/0'/0'")
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/1729'/1'/0'")
      expect(key1).not.toBe(key2)
    })

    it('should reject non-hardened paths for ED25519', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/1729'/0'/0"),
      ).rejects.toThrow('hardened')
    })
  })

  describe('getAddress', () => {
    it('should generate a tz1 address from a private key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const address = signer.getAddress(privateKey)

      // tz1 addresses start with "tz1"
      expect(address).toMatch(/^tz1/)
      // tz1 addresses are 36 characters long
      expect(address.length).toBe(36)
    })

    it('should generate deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const address1 = signer.getAddress(privateKey)
      const address2 = signer.getAddress(privateKey)
      expect(address1).toBe(address2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0xabcd')).toThrow('Invalid private key length')
    })
  })

  describe('getPublicKey', () => {
    it('should return an edpk-prefixed public key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const pubKey = signer.getPublicKey(privateKey)
      expect(pubKey).toMatch(/^edpk/)
    })
  })

  describe('signTransaction', () => {
    it('should sign a pre-forged transaction (legacy mode) and return forged + signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const mockForgedHex = '00'.repeat(32)

      const tx = {
        from: signer.getAddress(privateKey),
        to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        value: '1000000',
        data: '0x' + mockForgedHex,
      }

      const result = await signer.signTransaction({ privateKey: privateKey, tx: tx })

      // Result = forged bytes (32) + signature (64) = 96 bytes = 192 hex chars + 0x prefix
      expect(result).toMatch(/^0x[0-9a-f]+$/)
      const rawHex = result.slice(2)
      // 32 bytes forged + 64 bytes sig = 96 bytes = 192 hex chars
      expect(rawHex.length).toBe(192)
      // First 64 hex chars should be our original forged bytes
      expect(rawHex.slice(0, 64)).toBe(mockForgedHex)
    })

    it('should sign a structured transaction (forging mode)', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const fromAddr = signer.getAddress(privateKey)

      const tx = {
        from: fromAddr,
        to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        value: '1000000',
        extra: {
          branch: 'BLockGenesisGenesisGenesisGenesisGenesisf79b5d1CoW2',
          counter: '1',
          gasLimit: '10300',
          storageLimit: '0',
          fee: '1000',
        },
      }

      const result = await signer.signTransaction({ privateKey: privateKey, tx: tx })

      // Should return forged + signature as hex
      expect(result).toMatch(/^0x[0-9a-f]+$/)
      const rawBytes = result.slice(2)
      // Must be longer than 128 hex chars (64-byte signature alone)
      // Forged transaction is: 32 (branch) + 1 (tag) + 21 (source) + variable zarith fields + 22 (dest) + 1 (params flag) + 64 (sig)
      expect(rawBytes.length).toBeGreaterThan(128)
      // Last 128 hex chars are the 64-byte ED25519 signature
      const sigHex = rawBytes.slice(-128)
      expect(sigHex.length).toBe(128)
    })

    it('should produce deterministic results for structured transactions', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const fromAddr = signer.getAddress(privateKey)

      const tx = {
        from: fromAddr,
        to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        value: '500000',
        extra: {
          branch: 'BLockGenesisGenesisGenesisGenesisGenesisf79b5d1CoW2',
          counter: '5',
          gasLimit: '10300',
          storageLimit: '257',
          fee: '1500',
        },
      }

      const result1 = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      const result2 = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      expect(result1).toBe(result2)
    })

    it('should throw if neither data nor extra.branch is provided', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)

      await expect(
        signer.signTransaction({ privateKey: privateKey, tx: { from: 'tz1...', to: 'tz1...', value: '0' } }),
      ).rejects.toThrow('extra.branch')
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'Hello Tezos' })

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const message = new TextEncoder().encode('Hello Tezos')
      const signature = await signer.signMessage({ privateKey: privateKey, message: message })

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce deterministic signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'Hello Tezos' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'Hello Tezos' })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'Hello' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'World' })
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('end-to-end: mnemonic -> address', () => {
    it('should derive a consistent tz1 address from a known mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const address = signer.getAddress(privateKey)

      // Address should be valid tz1
      expect(address.startsWith('tz1')).toBe(true)
      expect(address.length).toBe(36)

      // Verify it is stable (snapshot-like test)
      const address2 = signer.getAddress(privateKey)
      expect(address).toBe(address2)
    })
  })
})

describe('Tezos binary encoding utilities', () => {
  describe('zarithEncode', () => {
    it('should encode 0', () => {
      const result = zarithEncode(0)
      expect(bytesToHex(result)).toBe('00')
    })

    it('should encode small values (< 128) as single byte', () => {
      expect(bytesToHex(zarithEncode(1))).toBe('01')
      expect(bytesToHex(zarithEncode(100))).toBe('64')
      expect(bytesToHex(zarithEncode(127))).toBe('7f')
    })

    it('should encode 128 as two bytes', () => {
      // 128 = 0b10000000 -> [0x80 | 0x00, 0x01] = [0x80, 0x01]
      expect(bytesToHex(zarithEncode(128))).toBe('8001')
    })

    it('should encode larger values', () => {
      // 1000 = 0b1111101000
      // First 7 bits: 1101000 = 0x68, with continuation: 0xe8
      // Next 7 bits: 0000111 = 0x07
      expect(bytesToHex(zarithEncode(1000))).toBe('e807')
    })

    it('should encode 10300 (common gas_limit)', () => {
      // 10300 = 0x2840 + 0x3c = ...
      const encoded = zarithEncode(10300)
      // Verify round-trip by decoding
      let value = 0n
      let shift = 0n
      for (const byte of encoded) {
        value |= BigInt(byte & 0x7f) << shift
        shift += 7n
      }
      expect(value).toBe(10300n)
    })

    it('should handle bigint values', () => {
      const result = zarithEncode(1000000n)
      // Verify round-trip
      let value = 0n
      let shift = 0n
      for (const byte of result) {
        value |= BigInt(byte & 0x7f) << shift
        shift += 7n
      }
      expect(value).toBe(1000000n)
    })
  })

  describe('decodeBlockHash', () => {
    it('should decode a genesis block hash to 32 bytes', () => {
      const raw = decodeBlockHash('BLockGenesisGenesisGenesisGenesisGenesisf79b5d1CoW2')
      expect(raw.length).toBe(32)
    })

    it('should produce deterministic results', () => {
      const hash = 'BLockGenesisGenesisGenesisGenesisGenesisf79b5d1CoW2'
      const raw1 = decodeBlockHash(hash)
      const raw2 = decodeBlockHash(hash)
      expect(bytesToHex(raw1)).toBe(bytesToHex(raw2))
    })
  })

  describe('decodeTz1Address', () => {
    it('should decode a tz1 address to 21 bytes (tag + hash)', () => {
      const raw = decodeTz1Address('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb')
      expect(raw.length).toBe(21)
      // First byte is tag 0x00 for tz1
      expect(raw[0]).toBe(0x00)
    })

    it('should throw for non-tz1 addresses', () => {
      expect(() => decodeTz1Address('tz2BFTyPeYRzxd5aiBchbXN3WCZhx7BqbMBq')).toThrow('tz1')
    })
  })

  describe('encodeDestination', () => {
    it('should encode a tz1 address as 22 bytes', () => {
      const result = encodeDestination('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb')
      expect(result.length).toBe(22)
      // First byte: 0x00 (implicit)
      expect(result[0]).toBe(0x00)
    })
  })

  describe('forgeTransaction', () => {
    it('should forge a basic transaction', () => {
      const forged = forgeTransaction({
        branch: 'BLockGenesisGenesisGenesisGenesisGenesisf79b5d1CoW2',
        source: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        destination: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        amount: '1000000',
        fee: '1000',
        counter: '1',
        gasLimit: '10300',
        storageLimit: '0',
      })

      // Should start with 32 bytes of branch
      expect(forged.length).toBeGreaterThan(32 + 1 + 21 + 22 + 1)

      // Byte at offset 32 should be transaction tag (0x6c)
      expect(forged[32]).toBe(0x6c)
    })

    it('should produce deterministic output', () => {
      const params = {
        branch: 'BLockGenesisGenesisGenesisGenesisGenesisf79b5d1CoW2',
        source: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        destination: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        amount: '500000',
        fee: '1500',
        counter: '42',
        gasLimit: '10300',
        storageLimit: '257',
      }

      const forged1 = forgeTransaction(params)
      const forged2 = forgeTransaction(params)
      expect(bytesToHex(forged1)).toBe(bytesToHex(forged2))
    })

    it('should encode zarith fields correctly within the forged output', () => {
      const forged = forgeTransaction({
        branch: 'BLockGenesisGenesisGenesisGenesisGenesisf79b5d1CoW2',
        source: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        destination: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        amount: '0',
        fee: '0',
        counter: '1',
        gasLimit: '0',
        storageLimit: '0',
      })

      // branch(32) + tag(1) + source(21) = offset 54
      // At offset 54: fee=0 (1 byte 0x00)
      expect(forged[54]).toBe(0x00) // fee = 0
      // offset 55: counter=1 (1 byte 0x01)
      expect(forged[55]).toBe(0x01) // counter = 1
      // offset 56: gasLimit=0 (1 byte 0x00)
      expect(forged[56]).toBe(0x00) // gasLimit = 0
      // offset 57: storageLimit=0 (1 byte 0x00)
      expect(forged[57]).toBe(0x00) // storageLimit = 0
      // offset 58: amount=0 (1 byte 0x00)
      expect(forged[58]).toBe(0x00) // amount = 0
      // offset 59..80: destination (22 bytes)
      // offset 81: params flag = 0x00
      expect(forged[forged.length - 1]).toBe(0x00) // no parameters
    })
  })

  describe('end-to-end: forge + sign', () => {
    const signer = new TezosSigner()
    const TEST_MNEMONIC =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const TEZOS_PATH = "m/44'/1729'/0'/0'"

    it('should forge and sign a complete transaction via signTransaction', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const fromAddr = signer.getAddress(privateKey)

      const tx = {
        from: fromAddr,
        to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        value: '1000000',
        extra: {
          branch: 'BLockGenesisGenesisGenesisGenesisGenesisf79b5d1CoW2',
          counter: '1',
          gasLimit: '10300',
          storageLimit: '0',
          fee: '1000',
        },
      }

      const signed = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      const rawHex = signed.slice(2) // remove 0x
      const rawBytes = new Uint8Array(rawHex.match(/.{2}/g)!.map(b => parseInt(b, 16)))

      // The result should be forged bytes + 64-byte signature
      const sigBytes = rawBytes.slice(-64)
      const forgedBytes = rawBytes.slice(0, -64)

      // Forged bytes should start with branch (32 bytes) + tag (0x6c)
      expect(forgedBytes[32]).toBe(0x6c)
      expect(sigBytes.length).toBe(64)

      // Signature should not be all zeros
      const allZeros = sigBytes.every(b => b === 0)
      expect(allZeros).toBe(false)
    })

    it('should match manual forge + sign', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, TEZOS_PATH)
      const fromAddr = signer.getAddress(privateKey)

      const forgeParams = {
        branch: 'BLockGenesisGenesisGenesisGenesisGenesisf79b5d1CoW2',
        source: fromAddr,
        destination: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        amount: '1000000',
        fee: '1000',
        counter: '1',
        gasLimit: '10300',
        storageLimit: '0',
      }

      const forgedManual = forgeTransaction(forgeParams)
      const forgedHex = bytesToHex(forgedManual)

      // Now sign using legacy mode with the manually forged bytes
      const legacyTx = {
        from: fromAddr,
        to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        value: '1000000',
        data: ('0x' + forgedHex) as `0x${string}`,
      }

      const legacyResult = await signer.signTransaction({ privateKey: privateKey, tx: legacyTx })

      // And sign using structured mode
      const structuredTx = {
        from: fromAddr,
        to: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        value: '1000000',
        extra: {
          branch: 'BLockGenesisGenesisGenesisGenesisGenesisf79b5d1CoW2',
          counter: '1',
          gasLimit: '10300',
          storageLimit: '0',
          fee: '1000',
        },
      }

      const structuredResult = await signer.signTransaction({ privateKey: privateKey, tx: structuredTx })

      // Both should produce the same result
      expect(structuredResult).toBe(legacyResult)
    })
  })
})
