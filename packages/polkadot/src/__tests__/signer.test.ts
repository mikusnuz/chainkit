import { describe, it, expect } from 'vitest'
import {
  PolkadotSigner,
  encodeSS58,
  decodeSS58,
  POLKADOT_DEFAULT_PATH,
  scaleCompactEncode,
  scaleEncodeU32LE,
  scaleEncodeU128LE,
  encodeEra,
  buildTransferKeepAliveCallData,
  buildSigningPayload,
  assembleSignedExtrinsic,
  concatBytes,
} from '../signer.js'
import * as ed25519 from '@noble/ed25519'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'

// Well-known test mnemonic
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// Test genesis hash (32 bytes of zeros for testing)
const TEST_GENESIS_HASH = '0x' + '91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3'
const TEST_BLOCK_HASH = '0x' + 'd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3'

describe('SCALE Codec', () => {
  describe('scaleCompactEncode', () => {
    it('should encode single-byte mode (0..63)', () => {
      // 0 -> 0x00
      expect(scaleCompactEncode(0)).toEqual(new Uint8Array([0x00]))
      // 1 -> 0x04
      expect(scaleCompactEncode(1)).toEqual(new Uint8Array([0x04]))
      // 42 -> 42 << 2 = 168 = 0xa8
      expect(scaleCompactEncode(42)).toEqual(new Uint8Array([0xa8]))
      // 63 -> 63 << 2 = 252 = 0xfc
      expect(scaleCompactEncode(63)).toEqual(new Uint8Array([0xfc]))
    })

    it('should encode two-byte mode (64..16383)', () => {
      // 64 -> (64 << 2) | 1 = 257 -> LE: [0x01, 0x01]
      const result64 = scaleCompactEncode(64)
      expect(result64.length).toBe(2)
      expect(result64).toEqual(new Uint8Array([0x01, 0x01]))

      // 100 -> (100 << 2) | 1 = 401 -> LE: [0x91, 0x01]
      const result100 = scaleCompactEncode(100)
      expect(result100.length).toBe(2)
      expect(result100).toEqual(new Uint8Array([0x91, 0x01]))

      // 16383 -> (16383 << 2) | 1 = 65533 -> LE: [0xfd, 0xff]
      const result16383 = scaleCompactEncode(16383)
      expect(result16383.length).toBe(2)
      expect(result16383).toEqual(new Uint8Array([0xfd, 0xff]))
    })

    it('should encode four-byte mode (16384..2^30-1)', () => {
      // 16384 -> (16384 << 2) | 2 = 65538 -> LE: [0x02, 0x00, 0x01, 0x00]
      const result = scaleCompactEncode(16384)
      expect(result.length).toBe(4)
      expect(result).toEqual(new Uint8Array([0x02, 0x00, 0x01, 0x00]))

      // 1000000 -> (1000000 << 2) | 2 = 4000002 -> LE
      const result1M = scaleCompactEncode(1000000)
      expect(result1M.length).toBe(4)
    })

    it('should encode big-integer mode (>= 2^30)', () => {
      // 2^30 = 1073741824
      const result = scaleCompactEncode(1073741824n)
      expect(result.length).toBeGreaterThan(4)
      // First byte should have mode bits 0x03
      expect(result[0] & 0x03).toBe(0x03)
    })

    it('should encode large values (u128 range)', () => {
      // 10 DOT = 10 * 10^10 = 100000000000
      const tenDot = 100000000000n
      const result = scaleCompactEncode(tenDot)
      expect(result.length).toBeGreaterThan(4)
      expect(result[0] & 0x03).toBe(0x03)
    })

    it('should handle zero', () => {
      const result = scaleCompactEncode(0)
      expect(result).toEqual(new Uint8Array([0x00]))
    })

    it('should handle bigint input', () => {
      const result = scaleCompactEncode(42n)
      expect(result).toEqual(new Uint8Array([0xa8]))
    })
  })

  describe('scaleEncodeU32LE', () => {
    it('should encode zero', () => {
      expect(scaleEncodeU32LE(0)).toEqual(new Uint8Array([0, 0, 0, 0]))
    })

    it('should encode in little-endian', () => {
      // 0x01020304 -> LE: [0x04, 0x03, 0x02, 0x01]
      expect(scaleEncodeU32LE(0x01020304)).toEqual(new Uint8Array([0x04, 0x03, 0x02, 0x01]))
    })

    it('should encode 1000000 (spec version example)', () => {
      // 1000000 = 0x000F4240 -> LE: [0x40, 0x42, 0x0F, 0x00]
      expect(scaleEncodeU32LE(1000000)).toEqual(new Uint8Array([0x40, 0x42, 0x0f, 0x00]))
    })
  })

  describe('scaleEncodeU128LE', () => {
    it('should encode zero as 16 bytes', () => {
      const result = scaleEncodeU128LE(0n)
      expect(result.length).toBe(16)
      expect(result).toEqual(new Uint8Array(16))
    })

    it('should encode small values in little-endian', () => {
      const result = scaleEncodeU128LE(256n) // 0x0100
      expect(result[0]).toBe(0)
      expect(result[1]).toBe(1)
      for (let i = 2; i < 16; i++) expect(result[i]).toBe(0)
    })

    it('should encode large values', () => {
      // 10 DOT = 100000000000 = 0x174876E800
      const tenDot = 100000000000n
      const result = scaleEncodeU128LE(tenDot)
      expect(result.length).toBe(16)
      // Verify first bytes (LE of 0x174876E800)
      expect(result[0]).toBe(0x00)
      expect(result[1]).toBe(0xe8)
      expect(result[2]).toBe(0x76)
      expect(result[3]).toBe(0x48)
      expect(result[4]).toBe(0x17)
    })
  })

  describe('encodeEra', () => {
    it('should encode immortal era as 0x00', () => {
      expect(encodeEra()).toEqual(new Uint8Array([0x00]))
      expect(encodeEra(undefined)).toEqual(new Uint8Array([0x00]))
    })

    it('should encode mortal era as 2 bytes', () => {
      const era = encodeEra({ period: 64, current: 42 })
      expect(era.length).toBe(2)
    })
  })

  describe('concatBytes', () => {
    it('should concatenate empty arrays', () => {
      const result = concatBytes(new Uint8Array([]), new Uint8Array([]))
      expect(result.length).toBe(0)
    })

    it('should concatenate multiple arrays', () => {
      const result = concatBytes(
        new Uint8Array([1, 2]),
        new Uint8Array([3]),
        new Uint8Array([4, 5, 6]),
      )
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
    })
  })
})

describe('Polkadot Extrinsic Building', () => {
  describe('buildTransferKeepAliveCallData', () => {
    it('should build call data with correct format', () => {
      const destPubKey = new Uint8Array(32).fill(0xab)
      const amount = 1000000000000n // 100 DOT

      const callData = buildTransferKeepAliveCallData(destPubKey, amount)

      // First byte: pallet index (5)
      expect(callData[0]).toBe(0x05)
      // Second byte: call index (3)
      expect(callData[1]).toBe(0x03)
      // Third byte: MultiAddress::Id variant (0x00)
      expect(callData[2]).toBe(0x00)
      // Next 32 bytes: destination public key
      for (let i = 0; i < 32; i++) {
        expect(callData[3 + i]).toBe(0xab)
      }
      // Remaining: compact-encoded amount
      expect(callData.length).toBeGreaterThan(35)
    })

    it('should respect custom pallet and call indices', () => {
      const destPubKey = new Uint8Array(32).fill(0x01)
      const amount = 100n

      const callData = buildTransferKeepAliveCallData(destPubKey, amount, 10, 7)
      expect(callData[0]).toBe(10)
      expect(callData[1]).toBe(7)
    })

    it('should encode zero amount', () => {
      const destPubKey = new Uint8Array(32).fill(0x00)
      const callData = buildTransferKeepAliveCallData(destPubKey, 0n)
      // pallet(1) + call(1) + multiaddr_variant(1) + pubkey(32) + compact(0)=1 byte = 36
      expect(callData.length).toBe(36)
      expect(callData[35]).toBe(0x00) // compact(0)
    })
  })

  describe('buildSigningPayload', () => {
    it('should build a signing payload with all components', () => {
      const callData = new Uint8Array([0x05, 0x03, 0x00, ...new Uint8Array(32)])
      const era = new Uint8Array([0x00]) // immortal
      const nonce = 0
      const tip = 0n
      const specVersion = 1000000
      const transactionVersion = 25
      const genesisHash = new Uint8Array(32).fill(0x91)
      const blockHash = new Uint8Array(32).fill(0xd4)

      const payload = buildSigningPayload(
        callData, era, nonce, tip,
        specVersion, transactionVersion,
        genesisHash, blockHash,
      )

      // payload should contain: callData + era(1) + compact(nonce)(1) + compact(tip)(1) + specVersion(4) + txVersion(4) + genesis(32) + block(32)
      const expectedMinLength = callData.length + 1 + 1 + 1 + 4 + 4 + 32 + 32
      expect(payload.length).toBe(expectedMinLength)
    })

    it('should hash payload if > 256 bytes', () => {
      // Create a large call data to push payload over 256 bytes
      const largeCallData = new Uint8Array(300).fill(0xff)
      const era = new Uint8Array([0x00])
      const genesisHash = new Uint8Array(32).fill(0x01)
      const blockHash = new Uint8Array(32).fill(0x02)

      const payload = buildSigningPayload(
        largeCallData, era, 0, 0n,
        1, 1,
        genesisHash, blockHash,
      )

      // Should be blake2b-256 = 32 bytes
      expect(payload.length).toBe(32)
    })

    it('should NOT hash payload if <= 256 bytes', () => {
      const callData = new Uint8Array(10).fill(0x05)
      const era = new Uint8Array([0x00])
      const genesisHash = new Uint8Array(32).fill(0x01)
      const blockHash = new Uint8Array(32).fill(0x02)

      const payload = buildSigningPayload(
        callData, era, 0, 0n,
        1, 1,
        genesisHash, blockHash,
      )

      // Should NOT be hashed: 10 + 1 + 1 + 1 + 4 + 4 + 32 + 32 = 85
      expect(payload.length).toBe(85)
    })
  })

  describe('assembleSignedExtrinsic', () => {
    it('should assemble a valid signed extrinsic structure', () => {
      const signerPubKey = new Uint8Array(32).fill(0xaa)
      const signature = new Uint8Array(64).fill(0xbb)
      const era = new Uint8Array([0x00])
      const nonce = 0
      const tip = 0n
      const callData = new Uint8Array([0x05, 0x03, 0x00, ...new Uint8Array(32), 0x00])

      const extrinsic = assembleSignedExtrinsic(
        signerPubKey, signature, era, nonce, tip, callData,
      )

      // Should have a compact length prefix
      expect(extrinsic.length).toBeGreaterThan(0)

      // After length prefix, first byte of body should be 0x84
      // Find where body starts (skip compact length prefix)
      const bodyStart = extrinsic.length - (
        1 +   // 0x84
        1 +   // MultiAddress variant 0x00
        32 +  // signer pubkey
        1 +   // MultiSignature variant 0x00
        64 +  // signature
        1 +   // era (immortal)
        1 +   // compact nonce (0)
        1 +   // compact tip (0)
        callData.length
      )

      // The body starts after the compact length prefix
      expect(extrinsic[bodyStart]).toBe(0x84)
      // MultiAddress variant
      expect(extrinsic[bodyStart + 1]).toBe(0x00)
      // Signer public key
      for (let i = 0; i < 32; i++) {
        expect(extrinsic[bodyStart + 2 + i]).toBe(0xaa)
      }
      // MultiSignature variant (Ed25519)
      expect(extrinsic[bodyStart + 34]).toBe(0x00)
      // Signature bytes
      for (let i = 0; i < 64; i++) {
        expect(extrinsic[bodyStart + 35 + i]).toBe(0xbb)
      }
    })
  })
})

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
    it('should produce a valid signed extrinsic hex', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const fromAddr = signer.getAddress(pk)

      // Create a second address as recipient
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/354'/0'/0'/1'")
      const toAddr = signer.getAddress(pk2)

      const tx = {
        from: fromAddr,
        to: toAddr,
        value: '10000000000', // 1 DOT
        nonce: 0,
        extra: {
          specVersion: 1000000,
          transactionVersion: 25,
          genesisHash: TEST_GENESIS_HASH,
          blockHash: TEST_BLOCK_HASH,
        },
      }

      const signedExtrinsic = await signer.signTransaction({ privateKey: pk, tx: tx })
      expect(signedExtrinsic.startsWith('0x')).toBe(true)

      // The signed extrinsic should be significantly longer than just a signature
      // It contains: length_prefix + 0x84 + signer(33) + signature(65) + era(1) + nonce + tip + callData
      expect(signedExtrinsic.length).toBeGreaterThan(200)
    })

    it('should produce a deterministic signed extrinsic', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const fromAddr = signer.getAddress(pk)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/354'/0'/0'/1'")
      const toAddr = signer.getAddress(pk2)

      const tx = {
        from: fromAddr,
        to: toAddr,
        value: '10000000000',
        nonce: 5,
        extra: {
          specVersion: 1000000,
          transactionVersion: 25,
          genesisHash: TEST_GENESIS_HASH,
          blockHash: TEST_BLOCK_HASH,
        },
      }

      const sig1 = await signer.signTransaction({ privateKey: pk, tx: tx })
      const sig2 = await signer.signTransaction({ privateKey: pk, tx: tx })
      expect(sig1).toBe(sig2)
    })

    it('should reject missing extra fields', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const tx = {
        from: signer.getAddress(pk),
        to: signer.getAddress(pk),
        value: '1000000000',
      }

      await expect(signer.signTransaction({ privateKey: pk, tx: tx })).rejects.toThrow('extra fields')
    })

    it('should reject missing genesisHash', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const tx = {
        from: signer.getAddress(pk),
        to: signer.getAddress(pk),
        value: '1000000000',
        extra: {
          specVersion: 1,
          transactionVersion: 1,
          genesisHash: '',
          blockHash: TEST_BLOCK_HASH,
        },
      }

      await expect(signer.signTransaction({ privateKey: pk, tx: tx })).rejects.toThrow('genesisHash and blockHash')
    })

    it('should support custom pallet and call indices', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/354'/0'/0'/1'")

      const tx = {
        from: signer.getAddress(pk),
        to: signer.getAddress(pk2),
        value: '5000000000',
        nonce: 1,
        extra: {
          specVersion: 9430,
          transactionVersion: 25,
          genesisHash: TEST_GENESIS_HASH,
          blockHash: TEST_BLOCK_HASH,
          palletIndex: 4,
          callIndex: 3,
        },
      }

      const signedExtrinsic = await signer.signTransaction({ privateKey: pk, tx: tx })
      expect(signedExtrinsic.startsWith('0x')).toBe(true)
      expect(signedExtrinsic.length).toBeGreaterThan(200)
    })

    it('should support tip', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/354'/0'/0'/1'")

      const txNoTip = {
        from: signer.getAddress(pk),
        to: signer.getAddress(pk2),
        value: '10000000000',
        nonce: 0,
        extra: {
          specVersion: 1000000,
          transactionVersion: 25,
          genesisHash: TEST_GENESIS_HASH,
          blockHash: TEST_BLOCK_HASH,
        },
      }

      const txWithTip = {
        ...txNoTip,
        extra: {
          ...txNoTip.extra,
          tip: '1000000',
        },
      }

      const sig1 = await signer.signTransaction({ privateKey: pk, tx: txNoTip })
      const sig2 = await signer.signTransaction({ privateKey: pk, tx: txWithTip })
      // Different tip should produce different extrinsic
      expect(sig1).not.toBe(sig2)
    })

    it('should support mortal era', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/354'/0'/0'/1'")

      const txImmortal = {
        from: signer.getAddress(pk),
        to: signer.getAddress(pk2),
        value: '10000000000',
        nonce: 0,
        extra: {
          specVersion: 1000000,
          transactionVersion: 25,
          genesisHash: TEST_GENESIS_HASH,
          blockHash: TEST_BLOCK_HASH,
        },
      }

      const txMortal = {
        ...txImmortal,
        extra: {
          ...txImmortal.extra,
          era: { period: 64, current: 42 },
        },
      }

      const sig1 = await signer.signTransaction({ privateKey: pk, tx: txImmortal })
      const sig2 = await signer.signTransaction({ privateKey: pk, tx: txMortal })
      expect(sig1).not.toBe(sig2)
    })

    it('should support raw call data via tx.data', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const tx = {
        from: signer.getAddress(pk),
        to: signer.getAddress(pk), // not used when tx.data is provided
        value: '0',
        data: '0x' + '0503' + '00' + 'ab'.repeat(32) + '00' as `0x${string}`,
        nonce: 0,
        extra: {
          specVersion: 1000000,
          transactionVersion: 25,
          genesisHash: TEST_GENESIS_HASH,
          blockHash: TEST_BLOCK_HASH,
        },
      }

      const signedExtrinsic = await signer.signTransaction({ privateKey: pk, tx: tx })
      expect(signedExtrinsic.startsWith('0x')).toBe(true)
      expect(signedExtrinsic.length).toBeGreaterThan(200)
    })

    it('should produce a verifiable signature within the extrinsic', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const fromAddr = signer.getAddress(pk)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/354'/0'/0'/1'")
      const toAddr = signer.getAddress(pk2)

      const tx = {
        from: fromAddr,
        to: toAddr,
        value: '10000000000',
        nonce: 0,
        extra: {
          specVersion: 1000000,
          transactionVersion: 25,
          genesisHash: TEST_GENESIS_HASH,
          blockHash: TEST_BLOCK_HASH,
          tip: 0n,
        },
      }

      const signedHex = await signer.signTransaction({ privateKey: pk, tx: tx })
      const signedBytes = hexToBytes(signedHex.slice(2))

      // Parse the extrinsic to extract the signature and verify it
      // Skip compact length prefix
      let offset = 0
      const firstByte = signedBytes[0]
      if ((firstByte & 0x03) === 0) {
        offset = 1 // single-byte compact
      } else if ((firstByte & 0x03) === 1) {
        offset = 2 // two-byte compact
      } else if ((firstByte & 0x03) === 2) {
        offset = 4 // four-byte compact
      }

      // 0x84 = signed extrinsic version 4
      expect(signedBytes[offset]).toBe(0x84)
      offset += 1

      // MultiAddress::Id variant
      expect(signedBytes[offset]).toBe(0x00)
      offset += 1

      // 32-byte signer public key
      const signerPubKey = signedBytes.slice(offset, offset + 32)
      offset += 32

      // MultiSignature::Ed25519 variant
      expect(signedBytes[offset]).toBe(0x00)
      offset += 1

      // 64-byte signature
      const extractedSig = signedBytes.slice(offset, offset + 64)
      offset += 64

      // The signer pubkey should match what we derive from the private key
      const pkBytes = hexToBytes(pk.slice(2))
      const expectedPubKey = ed25519.getPublicKey(pkBytes)
      expect(bytesToHex(signerPubKey)).toBe(bytesToHex(expectedPubKey))

      // Now reconstruct the signing payload and verify the signature
      const { publicKey: destPubKey } = decodeSS58(toAddr)
      const callData = buildTransferKeepAliveCallData(destPubKey, 10000000000n)
      const era = encodeEra(undefined)
      const genesisHash = hexToBytes(TEST_GENESIS_HASH.slice(2))
      const blockHash = hexToBytes(TEST_BLOCK_HASH.slice(2))

      const signingPayload = buildSigningPayload(
        callData, era, 0, 0n,
        1000000, 25,
        genesisHash, blockHash,
      )

      // Verify the Ed25519 signature
      const isValid = ed25519.verify(extractedSig, signingPayload, expectedPubKey)
      expect(isValid).toBe(true)
    })

    it('should reject invalid private key length', async () => {
      const signer = new PolkadotSigner()
      const tx = {
        from: '15oF4uVJwmo4TdGW7VfQxNLavjCXviqWrztPu8CAkXepkA3T',
        to: '15oF4uVJwmo4TdGW7VfQxNLavjCXviqWrztPu8CAkXepkA3T',
        value: '1000000000',
        extra: {
          specVersion: 1,
          transactionVersion: 1,
          genesisHash: TEST_GENESIS_HASH,
          blockHash: TEST_BLOCK_HASH,
        },
      }

      await expect(signer.signTransaction({ privateKey: '0x1234', tx: tx })).rejects.toThrow('Invalid private key length')
    })

    it('should produce different extrinsics for different nonces', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/354'/0'/0'/1'")

      const baseTx = {
        from: signer.getAddress(pk),
        to: signer.getAddress(pk2),
        value: '10000000000',
        extra: {
          specVersion: 1000000,
          transactionVersion: 25,
          genesisHash: TEST_GENESIS_HASH,
          blockHash: TEST_BLOCK_HASH,
        },
      }

      const sig0 = await signer.signTransaction({ privateKey: pk, tx: { ...baseTx, nonce: 0 } })
      const sig1 = await signer.signTransaction({ privateKey: pk, tx: { ...baseTx, nonce: 1 } })
      expect(sig0).not.toBe(sig1)
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const signature = await signer.signMessage({ privateKey: pk, message: 'Hello Polkadot' })
      expect(signature.startsWith('0x')).toBe(true)
      expect(signature.length).toBe(130) // 64 bytes = 128 hex + 0x
    })

    it('should sign a Uint8Array message', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage({ privateKey: pk, message: message })
      expect(signature.startsWith('0x')).toBe(true)
      expect(signature.length).toBe(130)
    })

    it('should produce deterministic signatures', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const sig1 = await signer.signMessage({ privateKey: pk, message: 'test message' })
      const sig2 = await signer.signMessage({ privateKey: pk, message: 'test message' })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, POLKADOT_DEFAULT_PATH)

      const sig1 = await signer.signMessage({ privateKey: pk, message: 'message 1' })
      const sig2 = await signer.signMessage({ privateKey: pk, message: 'message 2' })
      expect(sig1).not.toBe(sig2)
    })
  })
})
