import { describe, it, expect } from 'vitest'
import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  mnemonicToSeedSync,
  derivePath,
  derivePublicKey,
} from '../crypto/index.js'
import { ChainKitError, ErrorCode } from '../types/errors.js'

// Well-known test mnemonic from BIP39 spec
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('BIP39 - Mnemonic', () => {
  describe('generateMnemonic', () => {
    it('should generate a 12-word mnemonic by default (128 bits)', () => {
      const mnemonic = generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(12)
    })

    it('should generate a 24-word mnemonic with 256 bits', () => {
      const mnemonic = generateMnemonic(256)
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(24)
    })

    it('should generate valid mnemonics', () => {
      const mnemonic = generateMnemonic()
      expect(validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate different mnemonics each time', () => {
      const m1 = generateMnemonic()
      const m2 = generateMnemonic()
      expect(m1).not.toBe(m2)
    })

    it('should throw on invalid strength', () => {
      expect(() => generateMnemonic(100)).toThrow(ChainKitError)
      expect(() => generateMnemonic(100)).toThrow('Invalid mnemonic strength')
    })

    it('should support 160-bit (15 words)', () => {
      const mnemonic = generateMnemonic(160)
      expect(mnemonic.split(' ')).toHaveLength(15)
    })

    it('should support 192-bit (18 words)', () => {
      const mnemonic = generateMnemonic(192)
      expect(mnemonic.split(' ')).toHaveLength(18)
    })

    it('should support 224-bit (21 words)', () => {
      const mnemonic = generateMnemonic(224)
      expect(mnemonic.split(' ')).toHaveLength(21)
    })
  })

  describe('validateMnemonic', () => {
    it('should validate the test mnemonic', () => {
      expect(validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject invalid mnemonics', () => {
      expect(validateMnemonic('invalid mnemonic phrase')).toBe(false)
      expect(validateMnemonic('')).toBe(false)
      expect(validateMnemonic('abandon')).toBe(false)
    })

    it('should reject mnemonics with wrong checksum', () => {
      // Change the last word to break the checksum
      const bad = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'
      expect(validateMnemonic(bad)).toBe(false)
    })
  })

  describe('mnemonicToSeed', () => {
    it('should derive a 64-byte seed (async)', async () => {
      const seed = await mnemonicToSeed(TEST_MNEMONIC)
      expect(seed).toBeInstanceOf(Uint8Array)
      expect(seed.length).toBe(64)
    })

    it('should produce deterministic seeds', async () => {
      const seed1 = await mnemonicToSeed(TEST_MNEMONIC)
      const seed2 = await mnemonicToSeed(TEST_MNEMONIC)
      expect(seed1).toEqual(seed2)
    })

    it('should produce different seeds with different passphrases', async () => {
      const seed1 = await mnemonicToSeed(TEST_MNEMONIC)
      const seed2 = await mnemonicToSeed(TEST_MNEMONIC, 'my-passphrase')
      expect(seed1).not.toEqual(seed2)
    })

    it('should throw on invalid mnemonic', async () => {
      await expect(mnemonicToSeed('invalid words here')).rejects.toThrow(ChainKitError)
      await expect(mnemonicToSeed('invalid words here')).rejects.toMatchObject({
        code: ErrorCode.INVALID_MNEMONIC,
      })
    })
  })

  describe('mnemonicToSeedSync', () => {
    it('should derive a 64-byte seed (sync)', () => {
      const seed = mnemonicToSeedSync(TEST_MNEMONIC)
      expect(seed).toBeInstanceOf(Uint8Array)
      expect(seed.length).toBe(64)
    })

    it('should produce the same seed as async version', async () => {
      const syncSeed = mnemonicToSeedSync(TEST_MNEMONIC)
      const asyncSeed = await mnemonicToSeed(TEST_MNEMONIC)
      expect(syncSeed).toEqual(asyncSeed)
    })

    it('should throw on invalid mnemonic', () => {
      expect(() => mnemonicToSeedSync('not a valid mnemonic')).toThrow(ChainKitError)
    })
  })
})

describe('BIP32 - HD Key Derivation', () => {
  // Pre-compute seed for test performance
  let seed: Uint8Array

  // The known seed hex for the test mnemonic (no passphrase)
  // from BIP39 spec: abandon*11 + about
  const EXPECTED_SEED_HEX =
    '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'

  it('should produce the known seed for the test mnemonic', () => {
    seed = mnemonicToSeedSync(TEST_MNEMONIC)
    const hex = Array.from(seed)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    expect(hex).toBe(EXPECTED_SEED_HEX)
  })

  describe('derivePath', () => {
    it('should derive a private key from a seed', () => {
      seed = mnemonicToSeedSync(TEST_MNEMONIC)
      const privateKey = derivePath(seed, "m/44'/60'/0'/0/0")
      expect(privateKey).toBeTypeOf('string')
      expect(privateKey).toHaveLength(64) // 32 bytes as hex
    })

    it('should produce deterministic keys', () => {
      seed = mnemonicToSeedSync(TEST_MNEMONIC)
      const key1 = derivePath(seed, "m/44'/60'/0'/0/0")
      const key2 = derivePath(seed, "m/44'/60'/0'/0/0")
      expect(key1).toBe(key2)
    })

    it('should produce different keys for different paths', () => {
      seed = mnemonicToSeedSync(TEST_MNEMONIC)
      const key0 = derivePath(seed, "m/44'/60'/0'/0/0")
      const key1 = derivePath(seed, "m/44'/60'/0'/0/1")
      expect(key0).not.toBe(key1)
    })

    it('should produce different keys for different coin types', () => {
      seed = mnemonicToSeedSync(TEST_MNEMONIC)
      const ethKey = derivePath(seed, "m/44'/60'/0'/0/0")
      const btcKey = derivePath(seed, "m/44'/0'/0'/0/0")
      expect(ethKey).not.toBe(btcKey)
    })

    it('should throw on invalid path', () => {
      seed = mnemonicToSeedSync(TEST_MNEMONIC)
      expect(() => derivePath(seed, 'invalid')).toThrow(ChainKitError)
      expect(() => derivePath(seed, 'invalid')).toThrow('Invalid derivation path')
      expect(() => derivePath(seed, '')).toThrow(ChainKitError)
      expect(() => derivePath(seed, 'm')).toThrow(ChainKitError)
    })

    // Known test vector: BIP44 Ethereum path for test mnemonic
    it('should match known BIP44 Ethereum derivation for test mnemonic', () => {
      seed = mnemonicToSeedSync(TEST_MNEMONIC)
      const privateKey = derivePath(seed, "m/44'/60'/0'/0/0")
      // Known private key for this mnemonic + path
      expect(privateKey).toBe('1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727')
    })
  })

  describe('derivePublicKey', () => {
    it('should derive a compressed public key', () => {
      seed = mnemonicToSeedSync(TEST_MNEMONIC)
      const publicKey = derivePublicKey(seed, "m/44'/60'/0'/0/0")
      expect(publicKey).toBeTypeOf('string')
      expect(publicKey).toHaveLength(66) // 33 bytes compressed as hex
      // Compressed public keys start with 02 or 03
      expect(['02', '03']).toContain(publicKey.substring(0, 2))
    })

    it('should produce deterministic public keys', () => {
      seed = mnemonicToSeedSync(TEST_MNEMONIC)
      const pk1 = derivePublicKey(seed, "m/44'/60'/0'/0/0")
      const pk2 = derivePublicKey(seed, "m/44'/60'/0'/0/0")
      expect(pk1).toBe(pk2)
    })

    it('should throw on invalid path', () => {
      seed = mnemonicToSeedSync(TEST_MNEMONIC)
      expect(() => derivePublicKey(seed, 'bad')).toThrow(ChainKitError)
    })
  })
})
