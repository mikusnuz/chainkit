import { describe, it, expect } from 'vitest'
import { CosmosSigner } from '../signer.js'
import {
  encodeVarint,
  encodeField,
  encodeString,
  encodeBytes,
  encodeUint64Field,
  encodeMessage,
  encodeCoinRaw,
  encodeMsgSend,
  encodeAnyRaw,
  encodeTxBody,
  encodeAuthInfo,
  encodeSignDoc,
  encodeTxRaw,
  concat,
} from '../signer.js'
import { sha256 } from '@noble/hashes/sha256'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import * as secp256k1 from '@noble/secp256k1'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const COSMOS_HD_PATH = "m/44'/118'/0'/0/0"

describe('CosmosSigner', () => {
  const signer = new CosmosSigner()

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
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      expect(pk).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should produce deterministic keys', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should produce different keys for different paths', async () => {
      const pk0 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/118'/0'/0/0")
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/118'/0'/0/1")
      expect(pk0).not.toBe(pk1)
    })

    it('should produce a different key than the Ethereum path', async () => {
      const cosmosPk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const ethPk = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/0")
      expect(cosmosPk).not.toBe(ethPk)
    })
  })

  describe('getAddress', () => {
    it('should return a valid cosmos1 bech32 address', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const address = signer.getAddress(pk)

      // cosmos1... bech32 format
      expect(address).toMatch(/^cosmos1[a-z0-9]{38}$/)
    })

    it('should produce deterministic addresses', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)
      expect(addr1).toBe(addr2)
    })

    it('should match the expected address for the test mnemonic', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const address = signer.getAddress(pk)
      // Known cosmos address for the "abandon" test mnemonic at m/44'/118'/0'/0/0
      expect(address).toBe('cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4')
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })
  })

  describe('getAddress with custom prefix', () => {
    it('should generate addresses with custom prefix', async () => {
      const osmSigner = new CosmosSigner('osmo')
      const pk = await osmSigner.derivePrivateKey(TEST_MNEMONIC, "m/44'/118'/0'/0/0")
      const address = osmSigner.getAddress(pk)
      expect(address).toMatch(/^osmo1/)
    })
  })

  describe('signMessage', () => {
    it('should produce a valid 64-byte signature', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const sig = await signer.signMessage('Hello, Cosmos!', pk)

      // 0x + 128 hex chars = 64 bytes (r: 32 + s: 32)
      expect(sig).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce deterministic signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const sig1 = await signer.signMessage('test message', pk)
      const sig2 = await signer.signMessage('test message', pk)
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const sig1 = await signer.signMessage('message 1', pk)
      const sig2 = await signer.signMessage('message 2', pk)
      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const msgBytes = new TextEncoder().encode('Hello')
      const sig = await signer.signMessage(msgBytes, pk)
      expect(sig).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce the same signature for string and equivalent bytes', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const msg = 'Hello, Cosmos!'
      const sig1 = await signer.signMessage(msg, pk)
      const sig2 = await signer.signMessage(new TextEncoder().encode(msg), pk)
      expect(sig1).toBe(sig2)
    })
  })

  // ---------------------------------------------------------------------------
  // Protobuf encoding primitives
  // ---------------------------------------------------------------------------

  describe('protobuf encoding primitives', () => {
    describe('encodeVarint', () => {
      it('should encode 0', () => {
        expect(encodeVarint(0)).toEqual(new Uint8Array([0]))
      })

      it('should encode small values (< 128)', () => {
        expect(encodeVarint(1)).toEqual(new Uint8Array([1]))
        expect(encodeVarint(127)).toEqual(new Uint8Array([127]))
      })

      it('should encode multi-byte varints', () => {
        // 128 = 0x80 => varint: [0x80, 0x01]
        expect(encodeVarint(128)).toEqual(new Uint8Array([0x80, 0x01]))
        // 300 = 0x012C => varint: [0xAC, 0x02]
        expect(encodeVarint(300)).toEqual(new Uint8Array([0xac, 0x02]))
      })

      it('should encode bigint values', () => {
        expect(encodeVarint(0n)).toEqual(new Uint8Array([0]))
        expect(encodeVarint(300n)).toEqual(new Uint8Array([0xac, 0x02]))
      })

      it('should encode large values correctly', () => {
        // 200000 = 0x30D40
        const encoded = encodeVarint(200000)
        expect(encoded.length).toBeGreaterThan(1)
        // Verify by decoding
        let result = 0n
        for (let i = 0; i < encoded.length; i++) {
          result |= BigInt(encoded[i] & 0x7f) << BigInt(i * 7)
        }
        expect(result).toBe(200000n)
      })
    })

    describe('concat', () => {
      it('should concatenate empty arrays', () => {
        expect(concat()).toEqual(new Uint8Array(0))
      })

      it('should concatenate multiple arrays', () => {
        const a = new Uint8Array([1, 2])
        const b = new Uint8Array([3, 4, 5])
        expect(concat(a, b)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
      })
    })

    describe('encodeString', () => {
      it('should return empty array for empty string', () => {
        expect(encodeString(1, '')).toEqual(new Uint8Array(0))
      })

      it('should encode a string with field tag and length prefix', () => {
        const encoded = encodeString(1, 'test')
        // Tag: field 1, wire type 2 = (1 << 3) | 2 = 0x0A
        // Length: 4
        // Data: "test" = [0x74, 0x65, 0x73, 0x74]
        expect(encoded[0]).toBe(0x0a) // tag
        expect(encoded[1]).toBe(4)    // length
        expect(new TextDecoder().decode(encoded.slice(2))).toBe('test')
      })
    })

    describe('encodeBytes', () => {
      it('should return empty array for empty bytes', () => {
        expect(encodeBytes(1, new Uint8Array(0))).toEqual(new Uint8Array(0))
      })

      it('should encode bytes with tag and length prefix', () => {
        const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
        const encoded = encodeBytes(2, data)
        // Tag: field 2, wire type 2 = (2 << 3) | 2 = 0x12
        expect(encoded[0]).toBe(0x12)
        expect(encoded[1]).toBe(4)
        expect(encoded.slice(2)).toEqual(data)
      })
    })

    describe('encodeUint64Field', () => {
      it('should return empty array for 0', () => {
        expect(encodeUint64Field(1, 0)).toEqual(new Uint8Array(0))
      })

      it('should encode non-zero varint field', () => {
        const encoded = encodeUint64Field(1, 1)
        // Tag: field 1, wire type 0 = (1 << 3) | 0 = 0x08
        expect(encoded[0]).toBe(0x08)
        expect(encoded[1]).toBe(1)
      })
    })

    describe('encodeMessage', () => {
      it('should wrap inner fields with tag and length', () => {
        const inner = new Uint8Array([0x08, 0x01]) // field 1, varint 1
        const encoded = encodeMessage(1, inner)
        // Tag: field 1, wire type 2 = 0x0A
        expect(encoded[0]).toBe(0x0a)
        expect(encoded[1]).toBe(2) // length
        expect(encoded.slice(2)).toEqual(inner)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Cosmos message encoding
  // ---------------------------------------------------------------------------

  describe('Cosmos message encoding', () => {
    describe('encodeCoinRaw', () => {
      it('should encode a coin with denom and amount', () => {
        const encoded = encodeCoinRaw('uatom', '1000')
        // Should contain field 1 (denom) and field 2 (amount) as strings
        expect(encoded.length).toBeGreaterThan(0)

        // Manually verify: field 1 string "uatom", field 2 string "1000"
        let offset = 0

        // Field 1: tag=0x0A, len=5, "uatom"
        expect(encoded[offset++]).toBe(0x0a)
        expect(encoded[offset++]).toBe(5)
        expect(new TextDecoder().decode(encoded.slice(offset, offset + 5))).toBe('uatom')
        offset += 5

        // Field 2: tag=0x12, len=4, "1000"
        expect(encoded[offset++]).toBe(0x12)
        expect(encoded[offset++]).toBe(4)
        expect(new TextDecoder().decode(encoded.slice(offset, offset + 4))).toBe('1000')
      })
    })

    describe('encodeMsgSend', () => {
      it('should encode MsgSend with from, to, and amount', () => {
        const encoded = encodeMsgSend('cosmos1sender', 'cosmos1recipient', [
          { denom: 'uatom', amount: '1000000' },
        ])
        expect(encoded.length).toBeGreaterThan(0)

        // The encoded bytes should contain the from_address, to_address, and amount
        const hexStr = bytesToHex(encoded)
        // "cosmos1sender" in hex
        expect(hexStr).toContain(bytesToHex(new TextEncoder().encode('cosmos1sender')))
        expect(hexStr).toContain(bytesToHex(new TextEncoder().encode('cosmos1recipient')))
        expect(hexStr).toContain(bytesToHex(new TextEncoder().encode('uatom')))
        expect(hexStr).toContain(bytesToHex(new TextEncoder().encode('1000000')))
      })
    })

    describe('encodeAnyRaw', () => {
      it('should encode Any with type_url and value', () => {
        const value = new Uint8Array([1, 2, 3])
        const encoded = encodeAnyRaw('/cosmos.bank.v1beta1.MsgSend', value)
        const hexStr = bytesToHex(encoded)
        expect(hexStr).toContain(
          bytesToHex(new TextEncoder().encode('/cosmos.bank.v1beta1.MsgSend'))
        )
      })
    })

    describe('encodeTxBody', () => {
      it('should encode TxBody with messages and memo', () => {
        const msgSend = encodeMsgSend('cosmos1sender', 'cosmos1receiver', [
          { denom: 'uatom', amount: '500' },
        ])
        const bodyBytes = encodeTxBody(
          [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: msgSend }],
          'test memo',
        )
        expect(bodyBytes.length).toBeGreaterThan(0)

        const hexStr = bytesToHex(bodyBytes)
        expect(hexStr).toContain(bytesToHex(new TextEncoder().encode('test memo')))
      })

      it('should omit memo field when empty', () => {
        const msgSend = encodeMsgSend('cosmos1a', 'cosmos1b', [
          { denom: 'uatom', amount: '1' },
        ])
        const withMemo = encodeTxBody(
          [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: msgSend }],
          'memo',
        )
        const withoutMemo = encodeTxBody(
          [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: msgSend }],
          '',
        )
        // Without memo should be shorter
        expect(withoutMemo.length).toBeLessThan(withMemo.length)
      })
    })

    describe('encodeAuthInfo', () => {
      it('should encode AuthInfo with public key, sequence, fee, and gas', () => {
        const fakePubKey = new Uint8Array(33).fill(0x02)
        const authInfo = encodeAuthInfo(
          fakePubKey,
          0,
          [{ denom: 'uatom', amount: '2500' }],
          200000,
        )
        expect(authInfo.length).toBeGreaterThan(0)
      })

      it('should encode non-zero sequence', () => {
        const fakePubKey = new Uint8Array(33).fill(0x02)
        const authInfoSeq0 = encodeAuthInfo(
          fakePubKey, 0,
          [{ denom: 'uatom', amount: '2500' }], 200000,
        )
        const authInfoSeq5 = encodeAuthInfo(
          fakePubKey, 5,
          [{ denom: 'uatom', amount: '2500' }], 200000,
        )
        // sequence > 0 adds extra bytes
        expect(authInfoSeq5.length).toBeGreaterThan(authInfoSeq0.length)
      })
    })

    describe('encodeSignDoc', () => {
      it('should encode SignDoc with body, auth_info, chain_id, account_number', () => {
        const bodyBytes = new Uint8Array([1, 2, 3])
        const authInfoBytes = new Uint8Array([4, 5, 6])
        const signDoc = encodeSignDoc(bodyBytes, authInfoBytes, 'cosmoshub-4', 12345)
        expect(signDoc.length).toBeGreaterThan(0)

        const hexStr = bytesToHex(signDoc)
        expect(hexStr).toContain(bytesToHex(new TextEncoder().encode('cosmoshub-4')))
      })
    })

    describe('encodeTxRaw', () => {
      it('should encode TxRaw with body, auth_info, and signatures', () => {
        const body = new Uint8Array([1, 2])
        const authInfo = new Uint8Array([3, 4])
        const sig = new Uint8Array(64).fill(0xff)
        const txRaw = encodeTxRaw(body, authInfo, [sig])

        expect(txRaw.length).toBeGreaterThan(0)
        // Field 1 (body_bytes), field 2 (auth_info_bytes), field 3 (signature)
        expect(txRaw[0]).toBe(0x0a) // field 1, length-delimited
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Transaction signing (full flow)
  // ---------------------------------------------------------------------------

  describe('signTransaction', () => {
    it('should produce a valid hex-encoded TxRaw', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const fromAddress = signer.getAddress(pk)

      const tx = {
        from: fromAddress,
        to: 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu',
        value: '1000000',
        fee: { amount: '2500', denom: 'uatom', gas: '200000' },
        extra: {
          chainId: 'cosmoshub-4',
          accountNumber: 0,
          sequence: 0,
        },
      }

      const signedTx = await signer.signTransaction(tx, pk)

      // Should be 0x-prefixed hex
      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)

      // Decode hex to bytes
      const txRawBytes = hexToBytes(signedTx.slice(2))

      // TxRaw must contain field 1 (body_bytes), field 2 (auth_info_bytes), field 3 (signature)
      // Minimum: tag+len+body + tag+len+authinfo + tag+len+sig(64)
      expect(txRawBytes.length).toBeGreaterThan(64)

      // First byte should be 0x0a (field 1, wire type 2)
      expect(txRawBytes[0]).toBe(0x0a)
    })

    it('should produce deterministic signed transactions', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: 'cosmos1xyz',
        value: '500',
        fee: { amount: '1000', denom: 'uatom', gas: '100000' },
        extra: {
          chainId: 'cosmoshub-4',
          accountNumber: 0,
          sequence: 0,
        },
      }

      const sig1 = await signer.signTransaction(tx, pk)
      const sig2 = await signer.signTransaction(tx, pk)
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different chain IDs', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const baseTx = {
        from: signer.getAddress(pk),
        to: 'cosmos1xyz',
        value: '1000',
        fee: { amount: '2500', denom: 'uatom', gas: '200000' },
      }

      const sig1 = await signer.signTransaction(
        { ...baseTx, extra: { chainId: 'cosmoshub-4', accountNumber: 0, sequence: 0 } },
        pk,
      )
      const sig2 = await signer.signTransaction(
        { ...baseTx, extra: { chainId: 'theta-testnet-001', accountNumber: 0, sequence: 0 } },
        pk,
      )
      expect(sig1).not.toBe(sig2)
    })

    it('should produce different signatures for different sequences', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const baseTx = {
        from: signer.getAddress(pk),
        to: 'cosmos1xyz',
        value: '1000',
        fee: { amount: '2500', denom: 'uatom', gas: '200000' },
        extra: { chainId: 'cosmoshub-4', accountNumber: 0, sequence: 0 },
      }

      const sig1 = await signer.signTransaction(baseTx, pk)
      const sig2 = await signer.signTransaction(
        { ...baseTx, extra: { ...baseTx.extra, sequence: 1 } },
        pk,
      )
      expect(sig1).not.toBe(sig2)
    })

    it('should include the memo in the transaction body', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const txNoMemo = {
        from: signer.getAddress(pk),
        to: 'cosmos1xyz',
        value: '1000',
        fee: { amount: '2500', denom: 'uatom', gas: '200000' },
        extra: { chainId: 'cosmoshub-4', accountNumber: 0, sequence: 0 },
      }
      const txWithMemo = {
        ...txNoMemo,
        extra: { ...txNoMemo.extra, memo: 'hello world' },
      }

      const sig1 = await signer.signTransaction(txNoMemo, pk)
      const sig2 = await signer.signTransaction(txWithMemo, pk)
      expect(sig1).not.toBe(sig2)
    })

    it('should throw for invalid private key', async () => {
      const tx = {
        from: 'cosmos1abc',
        to: 'cosmos1xyz',
        value: '1000',
      }
      await expect(signer.signTransaction(tx, '0x1234')).rejects.toThrow('Invalid private key length')
    })

    it('should default to uatom denom when fee denom not specified', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: 'cosmos1xyz',
        value: '1000',
        extra: { chainId: 'cosmoshub-4', accountNumber: 0, sequence: 0 },
      }

      const signedTx = await signer.signTransaction(tx, pk)
      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
    })

    it('should produce a signature that can be verified', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const pkBytes = hexToBytes(pk.slice(2))
      const publicKey = secp256k1.getPublicKey(pkBytes, true)
      const fromAddress = signer.getAddress(pk)

      const tx = {
        from: fromAddress,
        to: 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu',
        value: '1000000',
        fee: { amount: '2500', denom: 'uatom', gas: '200000' },
        extra: {
          chainId: 'cosmoshub-4',
          accountNumber: 0,
          sequence: 0,
          denom: 'uatom',
        },
      }

      // Manually rebuild SignDoc to verify the signature
      const msgSendBytes = encodeMsgSend(tx.from, tx.to, [
        { denom: 'uatom', amount: tx.value },
      ])
      const bodyBytes = encodeTxBody(
        [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: msgSendBytes }],
        '',
      )
      const authInfoBytes = encodeAuthInfo(
        publicKey,
        0,
        [{ denom: 'uatom', amount: '2500' }],
        200000,
      )
      const signDocBytes = encodeSignDoc(bodyBytes, authInfoBytes, 'cosmoshub-4', 0)
      const signDocHash = sha256(signDocBytes)

      // Get the signed transaction
      const signedTx = await signer.signTransaction(tx, pk)
      const txRawBytes = hexToBytes(signedTx.slice(2))

      // Parse the TxRaw to extract the signature (last field 3)
      // Find the signature field: search for the last field 3 tag (0x1a)
      let sigStart = -1
      let offset = 0
      while (offset < txRawBytes.length) {
        const tag = txRawBytes[offset]
        const fieldNum = tag >> 3
        const wireType = tag & 0x07

        if (wireType === 2) { // length-delimited
          offset++
          let len = 0
          let shift = 0
          while (offset < txRawBytes.length) {
            const b = txRawBytes[offset++]
            len |= (b & 0x7f) << shift
            if ((b & 0x80) === 0) break
            shift += 7
          }
          if (fieldNum === 3) {
            sigStart = offset
          }
          offset += len
        } else {
          break
        }
      }

      expect(sigStart).toBeGreaterThan(0)
      const sigBytes = txRawBytes.slice(sigStart, sigStart + 64)
      expect(sigBytes.length).toBe(64)

      // Verify the signature using secp256k1
      const isValid = secp256k1.verify(
        secp256k1.Signature.fromCompact(sigBytes),
        signDocHash,
        publicKey,
      )
      expect(isValid).toBe(true)
    })

    it('should handle custom messages via extra.messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, COSMOS_HD_PATH)
      const fromAddress = signer.getAddress(pk)

      // Provide pre-encoded messages
      const customMsgValue = encodeMsgSend(fromAddress, 'cosmos1recv', [
        { denom: 'uosmo', amount: '5000' },
      ])

      const tx = {
        from: fromAddress,
        to: 'cosmos1recv',
        value: '5000',
        fee: { amount: '500', denom: 'uosmo', gas: '100000' },
        extra: {
          chainId: 'osmosis-1',
          accountNumber: 42,
          sequence: 7,
          messages: [
            { typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: customMsgValue },
          ],
        },
      }

      const signedTx = await signer.signTransaction(tx, pk)
      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)

      // The output should be different from default MsgSend construction
      // because accountNumber and sequence differ
      const txDefault = {
        from: fromAddress,
        to: 'cosmos1recv',
        value: '5000',
        fee: { amount: '500', denom: 'uosmo', gas: '100000' },
        extra: {
          chainId: 'osmosis-1',
          accountNumber: 0,
          sequence: 0,
        },
      }
      const signedDefault = await signer.signTransaction(txDefault, pk)
      expect(signedTx).not.toBe(signedDefault)
    })
  })
})
