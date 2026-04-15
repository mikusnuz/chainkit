import { describe, it, expect } from 'vitest'
import { IotaSigner, serializeTransactionEssence, buildTransactionPayload } from './signer.js'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { blake2b } from '@noble/hashes/blake2b'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { bech32 } from '@scure/base'
import type { IotaTransactionEssence } from './types.js'

// Ensure ed25519 sha512 is set
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

const IOTA_HD_PATH = "m/44'/4218'/0'/0'/0'"
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

/** Helper: read u8 from buffer at offset. */
function readU8(buf: Uint8Array, offset: number): number {
  return buf[offset]
}

/** Helper: read u16 LE from buffer at offset. */
function readU16LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8)
}

/** Helper: read u32 LE from buffer at offset. */
function readU32LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)
}

/** Helper: read u64 LE from buffer at offset as bigint. */
function readU64LE(buf: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let i = 0; i < 8; i++) {
    value |= BigInt(buf[offset + i]) << BigInt(i * 8)
  }
  return value
}

/** Create a dummy 32-byte transaction ID (hex). */
function makeTxId(fill: number): string {
  return bytesToHex(new Uint8Array(32).fill(fill))
}

/** Create a dummy 32-byte address hash (hex). */
function makeAddressHash(fill: number): string {
  return bytesToHex(new Uint8Array(32).fill(fill))
}

describe('IotaSigner', () => {
  const signer = new IotaSigner()

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
    it('should validate a correct mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key from a mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key deterministically', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/4218'/0'/0'/1'")
      expect(key1).not.toBe(key2)
    })

    it('should reject non-hardened paths for ED25519', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, 'm/44/4218/0/0/0'),
      ).rejects.toThrow('hardened')
    })

    it('should reject invalid paths', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, 'invalid'),
      ).rejects.toThrow('Invalid derivation path')
    })
  })

  describe('getAddress', () => {
    it('should return a bech32 address with iota HRP', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const address = signer.getAddress(privateKey)
      expect(address).toMatch(/^iota1/)
    })

    it('should return a valid bech32 address that decodes correctly', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const address = signer.getAddress(privateKey)

      // Decode and verify structure
      const decoded = bech32.decodeToBytes(address)
      // Should be 33 bytes: 1 type byte (0x00) + 32 hash bytes
      expect(decoded.bytes.length).toBe(33)
      expect(decoded.bytes[0]).toBe(0x00) // Ed25519 address type
    })

    it('should derive the correct address from the public key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      // Manually compute: blake2b-256(pubkey) -> prepend 0x00 -> bech32
      const addressHash = blake2b(publicKey, { dkLen: 32 })
      const addressData = new Uint8Array(33)
      addressData[0] = 0x00
      addressData.set(addressHash, 1)
      const words = bech32.toWords(addressData)
      const expectedAddress = bech32.encode('iota', words, 90)

      const address = signer.getAddress(privateKey)
      expect(address).toBe(expectedAddress)
    })

    it('should produce deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should reject invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('signTransaction - raw mode (backward compatibility)', () => {
    it('should sign raw essence bytes and return a valid signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: '0x' + bytesToHex(new Uint8Array(32).fill(0xab)),
        fee: { mode: 'raw' },
      }

      const signature = await signer.signTransaction(tx, privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/) // 64 bytes = 128 hex chars
    })

    it('should produce verifiable ED25519 signatures in raw mode', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const essenceData = new Uint8Array(32).fill(0xcd)
      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: '0x' + bytesToHex(essenceData),
        fee: { mode: 'raw' },
      }

      const signature = await signer.signTransaction(tx, privateKey)
      const sigBytes = hexToBytes(signature.slice(2))

      // IOTA signs the blake2b-256 hash of the essence
      const essenceHash = blake2b(essenceData, { dkLen: 32 })
      const valid = ed25519.verify(sigBytes, essenceHash, publicKey)
      expect(valid).toBe(true)
    })

    it('should fall back to raw mode for non-JSON hex data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: '0x' + bytesToHex(new Uint8Array(32).fill(0xab)),
      }

      // Without fee.mode='raw' but with non-JSON hex, should still work (fallback)
      const signature = await signer.signTransaction(tx, privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/) // 64 bytes = 128 hex chars
    })

    it('should reject missing transaction data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
      }

      await expect(signer.signTransaction(tx, privateKey)).rejects.toThrow(
        'Transaction data',
      )
    })
  })

  describe('signTransaction - structured mode (Stardust serialization)', () => {
    function makeEssence(overrides?: Partial<IotaTransactionEssence>): IotaTransactionEssence {
      return {
        networkId: '1234567890',
        inputs: [
          {
            type: 0,
            transactionId: makeTxId(0xaa),
            transactionOutputIndex: 0,
          },
        ],
        outputs: [
          {
            type: 3,
            amount: '1000000',
            unlockConditions: [
              {
                type: 0,
                address: {
                  type: 0,
                  pubKeyHash: makeAddressHash(0xbb),
                },
              },
            ],
          },
        ],
        ...overrides,
      }
    }

    it('should sign a structured transaction and return full payload', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const essence = makeEssence()

      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: JSON.stringify(essence),
      }

      const result = await signer.signTransaction(tx, privateKey)
      expect(result).toMatch(/^0x[0-9a-f]+$/)

      // The result should be longer than just a 64-byte signature
      // (payload_type(4) + essence + unlocks)
      const payloadBytes = hexToBytes(result.slice(2))
      expect(payloadBytes.length).toBeGreaterThan(128)
    })

    it('should produce a payload starting with transaction type 6', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const essence = makeEssence()

      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: JSON.stringify(essence),
      }

      const result = await signer.signTransaction(tx, privateKey)
      const payloadBytes = hexToBytes(result.slice(2))

      // First 4 bytes: payload_type = 6 (u32 LE)
      const payloadType = readU32LE(payloadBytes, 0)
      expect(payloadType).toBe(6)
    })

    it('should serialize the essence correctly in the payload', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const essence = makeEssence({ networkId: '9999' })

      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: JSON.stringify(essence),
      }

      const result = await signer.signTransaction(tx, privateKey)
      const payloadBytes = hexToBytes(result.slice(2))

      // offset 0: payload_type (4 bytes)
      // offset 4: essence_type (1 byte) = 1
      expect(readU8(payloadBytes, 4)).toBe(1) // REGULAR_ESSENCE_TYPE

      // offset 5: network_id (8 bytes u64 LE) = 9999
      expect(readU64LE(payloadBytes, 5)).toBe(9999n)

      // offset 13: inputs_count (2 bytes u16 LE) = 1
      expect(readU16LE(payloadBytes, 13)).toBe(1)
    })

    it('should serialize UTXO inputs correctly', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const txId = makeTxId(0xcc)
      const essence = makeEssence({
        inputs: [
          { type: 0, transactionId: txId, transactionOutputIndex: 2 },
        ],
      })

      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: JSON.stringify(essence),
      }

      const result = await signer.signTransaction(tx, privateKey)
      const payloadBytes = hexToBytes(result.slice(2))

      // After payload_type(4) + essence_type(1) + network_id(8) + inputs_count(2)
      // = offset 15: first input starts
      const inputOffset = 15

      // input_type = 0 (UTXO)
      expect(readU8(payloadBytes, inputOffset)).toBe(0)

      // transaction_id (32 bytes at offset+1)
      const readTxId = payloadBytes.slice(inputOffset + 1, inputOffset + 33)
      expect(bytesToHex(readTxId)).toBe(txId)

      // transaction_output_index = 2 (u16 LE at offset+33)
      expect(readU16LE(payloadBytes, inputOffset + 33)).toBe(2)
    })

    it('should serialize BasicOutput correctly', async () => {
      const addrHash = makeAddressHash(0xdd)
      const essence = makeEssence({
        outputs: [
          {
            type: 3,
            amount: '5000000',
            unlockConditions: [
              { type: 0, address: { type: 0, pubKeyHash: addrHash } },
            ],
          },
        ],
      })

      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '5000000',
        data: JSON.stringify(essence),
      }

      const result = await signer.signTransaction(tx, privateKey)
      const payloadBytes = hexToBytes(result.slice(2))

      // Calculate output offset:
      // payload_type(4) + essence_type(1) + network_id(8) + inputs_count(2)
      // + 1 input: input_type(1) + tx_id(32) + output_index(2) = 35
      // + inputs_commitment(32) + outputs_count(2)
      const outputOffset = 4 + 1 + 8 + 2 + 35 + 32 + 2

      // output_type = 3 (BasicOutput)
      expect(readU8(payloadBytes, outputOffset)).toBe(3)

      // amount = 5000000 (u64 LE)
      expect(readU64LE(payloadBytes, outputOffset + 1)).toBe(5000000n)

      // native_tokens_count = 0
      expect(readU8(payloadBytes, outputOffset + 9)).toBe(0)

      // unlock_conditions_count = 1
      expect(readU8(payloadBytes, outputOffset + 10)).toBe(1)

      // unlock_condition_type = 0 (AddressUnlockCondition)
      expect(readU8(payloadBytes, outputOffset + 11)).toBe(0)

      // address_type = 0 (Ed25519)
      expect(readU8(payloadBytes, outputOffset + 12)).toBe(0)

      // address_hash (32 bytes)
      const readAddrHash = payloadBytes.slice(outputOffset + 13, outputOffset + 45)
      expect(bytesToHex(readAddrHash)).toBe(addrHash)

      // features_count = 0
      expect(readU8(payloadBytes, outputOffset + 45)).toBe(0)
    })

    it('should include signature unlock with correct public key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const essence = makeEssence()
      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: JSON.stringify(essence),
      }

      const result = await signer.signTransaction(tx, privateKey)
      const payloadBytes = hexToBytes(result.slice(2))

      // Find the unlocks section
      // After the essence ends, unlocks_count (u16 LE) appears
      // Essence size: essence_type(1) + network_id(8) + inputs_count(2) +
      //   input(1+32+2) + inputs_commitment(32) + outputs_count(2) +
      //   output(1+8+1+1+1+1+32+1) + payload_length(4)
      // = 1 + 8 + 2 + 35 + 32 + 2 + 46 + 4 = 130
      // Plus payload_type(4) = 134 total offset to unlocks_count
      const unlocksCountOffset = 134

      const unlocksCount = readU16LE(payloadBytes, unlocksCountOffset)
      expect(unlocksCount).toBe(1)

      // First unlock starts at offset + 2
      const unlockOffset = unlocksCountOffset + 2

      // unlock_type = 0 (Signature)
      expect(readU8(payloadBytes, unlockOffset)).toBe(0)

      // signature_type = 0 (Ed25519)
      expect(readU8(payloadBytes, unlockOffset + 1)).toBe(0)

      // public_key (32 bytes at offset + 2)
      const readPubKey = payloadBytes.slice(unlockOffset + 2, unlockOffset + 34)
      expect(bytesToHex(readPubKey)).toBe(bytesToHex(publicKey))

      // signature (64 bytes at offset + 34)
      const readSig = payloadBytes.slice(unlockOffset + 34, unlockOffset + 98)
      expect(readSig.length).toBe(64)
    })

    it('should produce a verifiable signature in the payload', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const essence = makeEssence()
      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: JSON.stringify(essence),
      }

      const result = await signer.signTransaction(tx, privateKey)
      const payloadBytes = hexToBytes(result.slice(2))

      // Extract essence bytes (from offset 4 to before unlocks_count)
      // Essence length = 130 bytes (see calculation above)
      const essenceBytes = payloadBytes.slice(4, 4 + 130)

      // Extract signature from the unlock (unlock starts at offset 136)
      const unlockOffset = 136
      const sigBytes = payloadBytes.slice(unlockOffset + 34, unlockOffset + 98)

      // Hash the essence and verify the signature
      const essenceHash = blake2b(essenceBytes, { dkLen: 32 })
      const valid = ed25519.verify(sigBytes, essenceHash, publicKey)
      expect(valid).toBe(true)
    })

    it('should handle multiple inputs with reference unlocks', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const essence = makeEssence({
        inputs: [
          { type: 0, transactionId: makeTxId(0x11), transactionOutputIndex: 0 },
          { type: 0, transactionId: makeTxId(0x22), transactionOutputIndex: 1 },
          { type: 0, transactionId: makeTxId(0x33), transactionOutputIndex: 0 },
        ],
      })

      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: JSON.stringify(essence),
      }

      const result = await signer.signTransaction(tx, privateKey)
      const payloadBytes = hexToBytes(result.slice(2))

      // Essence: essence_type(1) + network_id(8) + inputs_count(2) +
      //   3 inputs * (1+32+2) + inputs_commitment(32) + outputs_count(2) +
      //   output(46) + payload_length(4)
      // = 1 + 8 + 2 + 105 + 32 + 2 + 46 + 4 = 200
      const unlocksCountOffset = 4 + 200 // payload_type(4) + essence(200)

      const unlocksCount = readU16LE(payloadBytes, unlocksCountOffset)
      expect(unlocksCount).toBe(3)

      // First unlock: Signature (type=0, sig_type=0, pubkey(32), sig(64))
      const firstUnlockOffset = unlocksCountOffset + 2
      expect(readU8(payloadBytes, firstUnlockOffset)).toBe(0) // Signature type

      // Second unlock: Reference (type=1, reference_index=0)
      const secondUnlockOffset = firstUnlockOffset + 1 + 1 + 32 + 64 // 98 bytes for signature unlock
      expect(readU8(payloadBytes, secondUnlockOffset)).toBe(1) // Reference type
      expect(readU16LE(payloadBytes, secondUnlockOffset + 1)).toBe(0) // reference to unlock 0

      // Third unlock: Reference (type=1, reference_index=0)
      const thirdUnlockOffset = secondUnlockOffset + 3
      expect(readU8(payloadBytes, thirdUnlockOffset)).toBe(1) // Reference type
      expect(readU16LE(payloadBytes, thirdUnlockOffset + 1)).toBe(0) // reference to unlock 0
    })

    it('should handle multiple outputs', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const essence = makeEssence({
        outputs: [
          {
            type: 3,
            amount: '1000000',
            unlockConditions: [
              { type: 0, address: { type: 0, pubKeyHash: makeAddressHash(0xaa) } },
            ],
          },
          {
            type: 3,
            amount: '2000000',
            unlockConditions: [
              { type: 0, address: { type: 0, pubKeyHash: makeAddressHash(0xbb) } },
            ],
          },
        ],
      })

      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '3000000',
        data: JSON.stringify(essence),
      }

      const result = await signer.signTransaction(tx, privateKey)
      const payloadBytes = hexToBytes(result.slice(2))

      // After payload_type(4) + essence_type(1) + network_id(8) + inputs_count(2) +
      // input(35) + inputs_commitment(32) = offset 82
      const outputsCountOffset = 82

      const outputsCount = readU16LE(payloadBytes, outputsCountOffset)
      expect(outputsCount).toBe(2)

      // First output at offset 84: amount = 1000000
      expect(readU64LE(payloadBytes, 84 + 1)).toBe(1000000n)

      // Second output at offset 84 + 46 = 130: amount = 2000000
      expect(readU64LE(payloadBytes, 130 + 1)).toBe(2000000n)
    })

    it('should reject essence with no inputs', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const essence = makeEssence({ inputs: [] })

      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: JSON.stringify(essence),
      }

      await expect(signer.signTransaction(tx, privateKey)).rejects.toThrow(
        'at least one input',
      )
    })

    it('should reject essence with no outputs', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const essence = makeEssence({ outputs: [] })

      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: JSON.stringify(essence),
      }

      await expect(signer.signTransaction(tx, privateKey)).rejects.toThrow(
        'at least one output',
      )
    })

    it('should reject invalid transaction ID length', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const essence = makeEssence({
        inputs: [
          { type: 0, transactionId: 'abcd', transactionOutputIndex: 0 },
        ],
      })

      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: JSON.stringify(essence),
      }

      await expect(signer.signTransaction(tx, privateKey)).rejects.toThrow(
        'Invalid transaction ID length',
      )
    })

    it('should reject invalid address hash length', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const essence = makeEssence({
        outputs: [
          {
            type: 3,
            amount: '1000000',
            unlockConditions: [
              { type: 0, address: { type: 0, pubKeyHash: 'abcd' } },
            ],
          },
        ],
      })

      const tx = {
        from: 'iota1...',
        to: 'iota1...',
        value: '1000000',
        data: JSON.stringify(essence),
      }

      await expect(signer.signTransaction(tx, privateKey)).rejects.toThrow(
        'Invalid address hash length',
      )
    })
  })

  describe('serializeTransactionEssence', () => {
    it('should produce deterministic output', () => {
      const essence: IotaTransactionEssence = {
        networkId: '42',
        inputs: [
          { type: 0, transactionId: makeTxId(0x01), transactionOutputIndex: 0 },
        ],
        outputs: [
          {
            type: 3,
            amount: '100',
            unlockConditions: [
              { type: 0, address: { type: 0, pubKeyHash: makeAddressHash(0x02) } },
            ],
          },
        ],
      }

      const bytes1 = serializeTransactionEssence(essence)
      const bytes2 = serializeTransactionEssence(essence)
      expect(bytesToHex(bytes1)).toBe(bytesToHex(bytes2))
    })

    it('should start with essence_type = 1', () => {
      const essence: IotaTransactionEssence = {
        networkId: '0',
        inputs: [
          { type: 0, transactionId: makeTxId(0x00), transactionOutputIndex: 0 },
        ],
        outputs: [
          {
            type: 3,
            amount: '0',
            unlockConditions: [
              { type: 0, address: { type: 0, pubKeyHash: makeAddressHash(0x00) } },
            ],
          },
        ],
      }

      const bytes = serializeTransactionEssence(essence)
      expect(bytes[0]).toBe(1)
    })

    it('should encode network_id as u64 LE', () => {
      const essence: IotaTransactionEssence = {
        networkId: '256',
        inputs: [
          { type: 0, transactionId: makeTxId(0x00), transactionOutputIndex: 0 },
        ],
        outputs: [
          {
            type: 3,
            amount: '0',
            unlockConditions: [
              { type: 0, address: { type: 0, pubKeyHash: makeAddressHash(0x00) } },
            ],
          },
        ],
      }

      const bytes = serializeTransactionEssence(essence)
      // network_id at offset 1, 8 bytes LE
      expect(readU64LE(bytes, 1)).toBe(256n)
    })

    it('should end with payload_length = 0', () => {
      const essence: IotaTransactionEssence = {
        networkId: '0',
        inputs: [
          { type: 0, transactionId: makeTxId(0x00), transactionOutputIndex: 0 },
        ],
        outputs: [
          {
            type: 3,
            amount: '0',
            unlockConditions: [
              { type: 0, address: { type: 0, pubKeyHash: makeAddressHash(0x00) } },
            ],
          },
        ],
      }

      const bytes = serializeTransactionEssence(essence)
      // Last 4 bytes should be payload_length = 0 (u32 LE)
      const lastFour = bytes.slice(bytes.length - 4)
      expect(readU32LE(lastFour, 0)).toBe(0)
    })
  })

  describe('buildTransactionPayload', () => {
    it('should start with payload_type = 6', () => {
      const essence: IotaTransactionEssence = {
        networkId: '0',
        inputs: [
          { type: 0, transactionId: makeTxId(0x00), transactionOutputIndex: 0 },
        ],
        outputs: [
          {
            type: 3,
            amount: '0',
            unlockConditions: [
              { type: 0, address: { type: 0, pubKeyHash: makeAddressHash(0x00) } },
            ],
          },
        ],
      }

      const pubKey = new Uint8Array(32).fill(0x01)
      const sig = new Uint8Array(64).fill(0x02)

      const payload = buildTransactionPayload(essence, pubKey, sig)
      expect(readU32LE(payload, 0)).toBe(6)
    })

    it('should reject invalid public key length', () => {
      const essence: IotaTransactionEssence = {
        networkId: '0',
        inputs: [
          { type: 0, transactionId: makeTxId(0x00), transactionOutputIndex: 0 },
        ],
        outputs: [
          {
            type: 3,
            amount: '0',
            unlockConditions: [
              { type: 0, address: { type: 0, pubKeyHash: makeAddressHash(0x00) } },
            ],
          },
        ],
      }

      const badPubKey = new Uint8Array(16)
      const sig = new Uint8Array(64)

      expect(() => buildTransactionPayload(essence, badPubKey, sig)).toThrow(
        'Invalid public key length',
      )
    })

    it('should reject invalid signature length', () => {
      const essence: IotaTransactionEssence = {
        networkId: '0',
        inputs: [
          { type: 0, transactionId: makeTxId(0x00), transactionOutputIndex: 0 },
        ],
        outputs: [
          {
            type: 3,
            amount: '0',
            unlockConditions: [
              { type: 0, address: { type: 0, pubKeyHash: makeAddressHash(0x00) } },
            ],
          },
        ],
      }

      const pubKey = new Uint8Array(32)
      const badSig = new Uint8Array(32)

      expect(() => buildTransactionPayload(essence, pubKey, badSig)).toThrow(
        'Invalid signature length',
      )
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const signature = await signer.signMessage('hello IOTA', privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const msg = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage(msg, privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce verifiable signatures for messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, IOTA_HD_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const message = 'verify this message'
      const signature = await signer.signMessage(message, privateKey)
      const sigBytes = hexToBytes(signature.slice(2))

      const msgBytes = new TextEncoder().encode(message)
      const valid = ed25519.verify(sigBytes, msgBytes, publicKey)
      expect(valid).toBe(true)
    })

    it('should reject invalid private key length', async () => {
      await expect(
        signer.signMessage('test', '0xabcdef'),
      ).rejects.toThrow('Invalid private key length')
    })
  })
})
