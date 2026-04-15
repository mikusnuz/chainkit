import { describe, it, expect } from 'vitest'
import {
  CardanoSigner,
  cborEncodeUint,
  cborEncodeBytes,
  cborEncodeArray,
  cborEncodeMap,
  cborEncodeTrue,
  cborEncodeNull,
  cborEncodeHeader,
  encodeTransactionBody,
  encodeWitnessSet,
  encodeFullTransaction,
} from './signer.js'
import * as ed25519 from '@noble/ed25519'
import { blake2b } from '@noble/hashes/blake2b'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'

const signer = new CardanoSigner()

// Well-known test mnemonic
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// CIP-1852 default path
const CARDANO_PATH = "m/1852'/1815'/0'/0/0"

describe('CardanoSigner', () => {
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
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should return false for an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase that should not work')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a 32-byte private key from a mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key deterministically', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/1852'/1815'/0'/0/0")
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/1852'/1815'/1'/0/0")

      expect(key1).not.toBe(key2)
    })

    it('should throw for an invalid path', async () => {
      await expect(signer.derivePrivateKey(TEST_MNEMONIC, 'invalid')).rejects.toThrow(
        'Invalid derivation path',
      )
    })
  })

  describe('getAddress', () => {
    it('should return a bech32 addr address', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const address = signer.getAddress(privateKey)

      expect(address).toMatch(/^addr1/)
    })

    it('should return the same address deterministically', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)

      expect(addr1).toBe(addr2)
    })

    it('should throw for an invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('signMessage', () => {
    it('should produce a valid ED25519 signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const message = 'Hello, Cardano!'
      const signature = await signer.signMessage(message, privateKey)

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/) // 64 bytes = 128 hex chars

      // Verify the signature
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)
      const sigBytes = hexToBytes(signature.slice(2))
      const msgBytes = new TextEncoder().encode(message)

      const isValid = ed25519.verify(sigBytes, msgBytes, publicKey)
      expect(isValid).toBe(true)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      const sig1 = await signer.signMessage('message 1', privateKey)
      const sig2 = await signer.signMessage('message 2', privateKey)

      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage(message, privateKey)

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should throw for an invalid private key length', async () => {
      await expect(signer.signMessage('test', '0xdead')).rejects.toThrow(
        'Invalid private key length',
      )
    })
  })

  describe('signTransaction (legacy mode)', () => {
    it('should sign a transaction with hex-encoded data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      // 32-byte hash (simulating a CBOR-serialized tx body hash)
      const txBodyHash = '0x' + bytesToHex(new Uint8Array(32).fill(0xab))

      const signature = await signer.signTransaction(
        {
          from: 'addr1...',
          to: 'addr1...',
          value: '1000000',
          data: txBodyHash,
        },
        privateKey,
      )

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)

      // Verify the signature
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)
      const sigBytes = hexToBytes(signature.slice(2))
      const hashBytes = hexToBytes(txBodyHash.slice(2))

      const isValid = ed25519.verify(sigBytes, hashBytes, publicKey)
      expect(isValid).toBe(true)
    })

    it('should throw when transaction data is missing', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      await expect(
        signer.signTransaction(
          { from: 'addr1...', to: 'addr1...', value: '1000000' },
          privateKey,
        ),
      ).rejects.toThrow('Transaction data')
    })

    it('should hash non-32-byte data with blake2b-256', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)

      // Provide raw CBOR data (not a 32-byte hash)
      const rawCborData = '0x' + bytesToHex(new Uint8Array(100).fill(0xcd))

      const signature = await signer.signTransaction(
        {
          from: 'addr1...',
          to: 'addr1...',
          value: '1000000',
          data: rawCborData,
        },
        privateKey,
      )

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })
  })

  describe('CBOR encoder', () => {
    describe('cborEncodeUint', () => {
      it('should encode small integers (0-23) as single byte', () => {
        expect(Array.from(cborEncodeUint(0))).toEqual([0x00])
        expect(Array.from(cborEncodeUint(1))).toEqual([0x01])
        expect(Array.from(cborEncodeUint(23))).toEqual([0x17])
      })

      it('should encode 24-255 as 2 bytes', () => {
        expect(Array.from(cborEncodeUint(24))).toEqual([0x18, 24])
        expect(Array.from(cborEncodeUint(255))).toEqual([0x18, 255])
      })

      it('should encode 256-65535 as 3 bytes', () => {
        expect(Array.from(cborEncodeUint(256))).toEqual([0x19, 0x01, 0x00])
        expect(Array.from(cborEncodeUint(1000))).toEqual([0x19, 0x03, 0xe8])
        expect(Array.from(cborEncodeUint(65535))).toEqual([0x19, 0xff, 0xff])
      })

      it('should encode 65536-4294967295 as 5 bytes', () => {
        expect(Array.from(cborEncodeUint(65536))).toEqual([0x1a, 0x00, 0x01, 0x00, 0x00])
        expect(Array.from(cborEncodeUint(1000000))).toEqual([0x1a, 0x00, 0x0f, 0x42, 0x40])
      })

      it('should encode bigint values above 32-bit as 9 bytes', () => {
        const result = cborEncodeUint(BigInt('5000000000'))
        expect(result[0]).toBe(0x1b)
        expect(result.length).toBe(9)
      })

      it('should encode bigint lovelace amounts correctly', () => {
        // 2 ADA = 2000000 lovelace
        const result = cborEncodeUint(BigInt('2000000'))
        expect(Array.from(result)).toEqual([0x1a, 0x00, 0x1e, 0x84, 0x80])
      })
    })

    describe('cborEncodeBytes', () => {
      it('should encode empty bytes', () => {
        const result = cborEncodeBytes(new Uint8Array([]))
        expect(Array.from(result)).toEqual([0x40]) // major type 2, length 0
      })

      it('should encode short byte strings', () => {
        const result = cborEncodeBytes(new Uint8Array([0xaa, 0xbb]))
        expect(Array.from(result)).toEqual([0x42, 0xaa, 0xbb])
      })

      it('should encode 32-byte hash', () => {
        const hash = new Uint8Array(32).fill(0xff)
        const result = cborEncodeBytes(hash)
        expect(result[0]).toBe(0x58) // 0x40 | 24 = major type 2, 1-byte length
        expect(result[1]).toBe(32)
        expect(result.length).toBe(34)
      })
    })

    describe('cborEncodeArray', () => {
      it('should encode empty array', () => {
        const result = cborEncodeArray([])
        expect(Array.from(result)).toEqual([0x80])
      })

      it('should encode array of uints', () => {
        const result = cborEncodeArray([cborEncodeUint(1), cborEncodeUint(2)])
        expect(Array.from(result)).toEqual([0x82, 0x01, 0x02])
      })
    })

    describe('cborEncodeMap', () => {
      it('should encode empty map', () => {
        const result = cborEncodeMap([])
        expect(Array.from(result)).toEqual([0xa0])
      })

      it('should encode single-entry map', () => {
        const result = cborEncodeMap([[cborEncodeUint(0), cborEncodeUint(42)]])
        expect(Array.from(result)).toEqual([0xa1, 0x00, 0x18, 42])
      })
    })

    describe('cborEncodeTrue / cborEncodeNull', () => {
      it('should encode true as 0xf5', () => {
        expect(Array.from(cborEncodeTrue())).toEqual([0xf5])
      })

      it('should encode null as 0xf6', () => {
        expect(Array.from(cborEncodeNull())).toEqual([0xf6])
      })
    })
  })

  describe('Transaction body encoding', () => {
    it('should produce valid CBOR for a simple transaction', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const address = signer.getAddress(privateKey)

      const txData = {
        inputs: [
          {
            txHash: 'aa'.repeat(32), // 32 bytes of 0xaa
            outputIndex: 0,
          },
        ],
        outputs: [
          {
            address,
            amount: '2000000', // 2 ADA
          },
        ],
        fee: '170000',
        ttl: 50000000,
      }

      const bodyBytes = encodeTransactionBody(txData)

      // Should start with a 4-element map header (0xa4)
      expect(bodyBytes[0]).toBe(0xa4)

      // Verify it's valid CBOR that can be hashed
      const hash = blake2b(bodyBytes, { dkLen: 32 })
      expect(hash.length).toBe(32)
    })

    it('should produce deterministic output', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const address = signer.getAddress(privateKey)

      const txData = {
        inputs: [{ txHash: 'bb'.repeat(32), outputIndex: 1 }],
        outputs: [{ address, amount: '1000000' }],
        fee: '180000',
        ttl: 60000000,
      }

      const body1 = encodeTransactionBody(txData)
      const body2 = encodeTransactionBody(txData)

      expect(bytesToHex(body1)).toBe(bytesToHex(body2))
    })
  })

  describe('Witness set encoding', () => {
    it('should produce a valid witness set with vkey and signature', () => {
      const pubkey = new Uint8Array(32).fill(0x11)
      const sig = new Uint8Array(64).fill(0x22)

      const witnessSet = encodeWitnessSet(pubkey, sig)

      // Should start with a 1-element map (0xa1)
      expect(witnessSet[0]).toBe(0xa1)
      // Key should be uint 0
      expect(witnessSet[1]).toBe(0x00)
    })
  })

  describe('Full transaction encoding', () => {
    it('should wrap body and witnesses in a 4-element array', () => {
      const bodyBytes = cborEncodeMap([
        [cborEncodeUint(0), cborEncodeArray([])],
        [cborEncodeUint(1), cborEncodeArray([])],
        [cborEncodeUint(2), cborEncodeUint(0)],
        [cborEncodeUint(3), cborEncodeUint(0)],
      ])
      const witnessBytes = cborEncodeMap([])

      const fullTx = encodeFullTransaction(bodyBytes, witnessBytes)

      // Should start with a 4-element array header (0x84)
      expect(fullTx[0]).toBe(0x84)
    })
  })

  describe('signTransaction (structured CBOR mode)', () => {
    it('should produce a fully serialized CBOR transaction', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const address = signer.getAddress(privateKey)

      const result = await signer.signTransaction(
        {
          from: address,
          to: address,
          value: '2000000',
          extra: {
            cardano: {
              inputs: [
                {
                  txHash: 'aa'.repeat(32),
                  outputIndex: 0,
                },
              ],
              outputs: [
                {
                  address,
                  amount: '2000000',
                },
              ],
              fee: '170000',
              ttl: 50000000,
            },
          },
        },
        privateKey,
      )

      // Should return a hex-encoded CBOR transaction (not just a signature)
      expect(result).toMatch(/^0x/)
      const txBytes = hexToBytes(result.slice(2))

      // Full transaction starts with 0x84 (4-element CBOR array)
      expect(txBytes[0]).toBe(0x84)

      // Should be longer than just a 64-byte signature
      expect(txBytes.length).toBeGreaterThan(64)
    })

    it('should produce a verifiable signature inside the transaction', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)
      const address = signer.getAddress(privateKey)

      const cardanoData = {
        inputs: [{ txHash: 'cc'.repeat(32), outputIndex: 0 }],
        outputs: [{ address, amount: '1500000' }],
        fee: '175000',
        ttl: 55000000,
      }

      const result = await signer.signTransaction(
        {
          from: address,
          to: address,
          value: '1500000',
          extra: { cardano: cardanoData },
        },
        privateKey,
      )

      // Re-encode the body and hash it independently
      const txBodyCbor = encodeTransactionBody(cardanoData)
      const txBodyHash = blake2b(txBodyCbor, { dkLen: 32 })

      // The full tx CBOR contains the signature -- verify it manually
      // by extracting the public key and signature from the witness set.
      // For simplicity, we verify that signing the same body hash
      // with the same key matches what's in the result.
      const expectedSig = ed25519.sign(txBodyHash, pkBytes)
      const expectedWitness = encodeWitnessSet(publicKey, expectedSig)
      const expectedFull = encodeFullTransaction(txBodyCbor, expectedWitness)

      expect(result).toBe('0x' + bytesToHex(expectedFull))
    })

    it('should produce deterministic output', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const address = signer.getAddress(privateKey)

      const tx = {
        from: address,
        to: address,
        value: '2000000',
        extra: {
          cardano: {
            inputs: [{ txHash: 'dd'.repeat(32), outputIndex: 0 }],
            outputs: [{ address, amount: '2000000' }],
            fee: '170000',
            ttl: 50000000,
          },
        },
      }

      const result1 = await signer.signTransaction(tx, privateKey)
      const result2 = await signer.signTransaction(tx, privateKey)

      expect(result1).toBe(result2)
    })

    it('should throw when inputs are empty', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const address = signer.getAddress(privateKey)

      await expect(
        signer.signTransaction(
          {
            from: address,
            to: address,
            value: '2000000',
            extra: {
              cardano: {
                inputs: [],
                outputs: [{ address, amount: '2000000' }],
                fee: '170000',
                ttl: 50000000,
              },
            },
          },
          privateKey,
        ),
      ).rejects.toThrow('at least one input')
    })

    it('should throw when outputs are empty', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const address = signer.getAddress(privateKey)

      await expect(
        signer.signTransaction(
          {
            from: address,
            to: address,
            value: '2000000',
            extra: {
              cardano: {
                inputs: [{ txHash: 'aa'.repeat(32), outputIndex: 0 }],
                outputs: [],
                fee: '170000',
                ttl: 50000000,
              },
            },
          },
          privateKey,
        ),
      ).rejects.toThrow('at least one output')
    })

    it('should handle multiple inputs and outputs', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const address = signer.getAddress(privateKey)

      const result = await signer.signTransaction(
        {
          from: address,
          to: address,
          value: '5000000',
          extra: {
            cardano: {
              inputs: [
                { txHash: 'aa'.repeat(32), outputIndex: 0 },
                { txHash: 'bb'.repeat(32), outputIndex: 1 },
              ],
              outputs: [
                { address, amount: '3000000' },
                { address, amount: '1830000' },
              ],
              fee: '170000',
              ttl: 50000000,
            },
          },
        },
        privateKey,
      )

      expect(result).toMatch(/^0x/)
      const txBytes = hexToBytes(result.slice(2))
      expect(txBytes[0]).toBe(0x84)
    })

    it('should handle large lovelace amounts (bigint)', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, CARDANO_PATH)
      const address = signer.getAddress(privateKey)

      const result = await signer.signTransaction(
        {
          from: address,
          to: address,
          value: '45000000000000', // 45 million ADA
          extra: {
            cardano: {
              inputs: [{ txHash: 'ee'.repeat(32), outputIndex: 0 }],
              outputs: [{ address, amount: '45000000000000' }],
              fee: '200000',
              ttl: 99999999,
            },
          },
        },
        privateKey,
      )

      expect(result).toMatch(/^0x/)
      const txBytes = hexToBytes(result.slice(2))
      expect(txBytes[0]).toBe(0x84)
    })
  })

  describe('end-to-end', () => {
    it('should derive key, get address, and sign from the same mnemonic', async () => {
      const mnemonic = signer.generateMnemonic()
      expect(signer.validateMnemonic(mnemonic)).toBe(true)

      const privateKey = await signer.derivePrivateKey(mnemonic, CARDANO_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)

      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^addr1/)

      const signature = await signer.signMessage('test', privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should do full CBOR transaction round-trip', async () => {
      const mnemonic = signer.generateMnemonic()
      const privateKey = await signer.derivePrivateKey(mnemonic, CARDANO_PATH)
      const address = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction(
        {
          from: address,
          to: address,
          value: '1000000',
          extra: {
            cardano: {
              inputs: [{ txHash: 'ff'.repeat(32), outputIndex: 0 }],
              outputs: [{ address, amount: '830000' }],
              fee: '170000',
              ttl: 100000000,
            },
          },
        },
        privateKey,
      )

      expect(signedTx).toMatch(/^0x/)
      const txBytes = hexToBytes(signedTx.slice(2))
      // 4-element CBOR array: [body, witnesses, true, null]
      expect(txBytes[0]).toBe(0x84)
      // Must contain true (0xf5) and null (0xf6) somewhere
      expect(signedTx).toContain('f5')
      expect(signedTx).toContain('f6')
    })
  })
})
