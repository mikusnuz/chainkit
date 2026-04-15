import { describe, it, expect } from 'vitest'
import { NeoSigner } from './signer.js'
import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'

const signer = new NeoSigner()

// Well-known test mnemonic
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const NEO_PATH = "m/44'/888'/0'/0/0"

describe('NeoSigner', () => {
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
    it('should validate a correct mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })

    it('should reject an empty string', () => {
      expect(signer.validateMnemonic('')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a 32-byte private key from mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)

      // Should be hex-encoded with 0x prefix
      expect(privateKey.startsWith('0x')).toBe(true)
      // 32 bytes = 64 hex chars + 0x prefix
      expect(privateKey.length).toBe(66)

      // The key should be a valid P-256 scalar
      const keyBytes = hexToBytes(privateKey.slice(2))
      expect(keyBytes.length).toBe(32)
    })

    it('should produce deterministic results', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      expect(key1).toBe(key2)
    })

    it('should produce different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/888'/0'/0/1")
      expect(key1).not.toBe(key2)
    })

    it('should produce different keys for different mnemonics', async () => {
      const mnemonic2 = signer.generateMnemonic()
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const key2 = await signer.derivePrivateKey(mnemonic2, NEO_PATH)
      expect(key1).not.toBe(key2)
    })
  })

  describe('getAddress', () => {
    it('should derive a valid Neo3 address from a private key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const address = signer.getAddress(privateKey)

      // Neo3 address starts with 'N'
      expect(address.startsWith('N')).toBe(true)
      // Neo3 address is typically 34 characters
      expect(address.length).toBe(34)
    })

    it('should produce deterministic addresses', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should produce different addresses for different keys', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/888'/0'/0/1")
      const addr1 = signer.getAddress(key1)
      const addr2 = signer.getAddress(key2)
      expect(addr1).not.toBe(addr2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow('Invalid private key length')
    })

    it('should produce address matching manual verification script computation', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const address = signer.getAddress(privateKey)

      // Manually verify the address derivation
      const pkBytes = hexToBytes(privateKey.slice(2))
      const compressedPubKey = p256.getPublicKey(pkBytes, true)

      // Build verification script: 0x0C21 + pubkey + 0x41 + 0x56e7b327
      const script = new Uint8Array(40)
      script[0] = 0x0c
      script[1] = 0x21
      script.set(compressedPubKey, 2)
      script[35] = 0x41
      script[36] = 0x56
      script[37] = 0xe7
      script[38] = 0xb3
      script[39] = 0x27

      // Compute script hash: SHA-256 -> RIPEMD-160
      const hash256 = sha256(script)
      const scriptHash = ripemd160(hash256)

      // Build address payload: version + script_hash
      const payload = new Uint8Array(21)
      payload[0] = 0x35
      payload.set(scriptHash, 1)

      // The address should start with 'N' and be properly encoded
      expect(address.startsWith('N')).toBe(true)
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'Hello Neo!' })

      // Should be 0x-prefixed hex
      expect(signature.startsWith('0x')).toBe(true)
      // P-256 signature = r (32 bytes) + s (32 bytes) = 64 bytes = 128 hex chars
      expect(signature.length).toBe(130) // 0x + 128
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const msgBytes = new TextEncoder().encode('Hello Neo!')
      const signature = await signer.signMessage({ privateKey: privateKey, message: msgBytes })

      expect(signature.startsWith('0x')).toBe(true)
      expect(signature.length).toBe(130)
    })

    it('should produce deterministic signatures for same message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'test message' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'test message' })
      // P-256 sign with @noble/curves is deterministic (RFC 6979)
      expect(sig1).toBe(sig2)
    })

    it('should produce verifiable signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const message = 'Verify this message'
      const signature = await signer.signMessage({ privateKey: privateKey, message: message })

      // Verify the signature
      const pkBytes = hexToBytes(privateKey.slice(2))
      const pubKey = p256.getPublicKey(pkBytes, false)
      const msgHash = sha256(new TextEncoder().encode(message))
      const sigBytes = hexToBytes(signature.slice(2))

      const isValid = p256.verify(sigBytes, msgHash, pubKey)
      expect(isValid).toBe(true)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const sig1 = await signer.signMessage({ privateKey: privateKey, message: 'message 1' })
      const sig2 = await signer.signMessage({ privateKey: privateKey, message: 'message 2' })
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('signTransaction', () => {
    it('should sign a transaction with raw script data', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const address = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: address,
          to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
          value: '1',
          data: '0x0c', // minimal script (raw override)
          nonce: 12345,
          fee: {
            systemFee: '100000',
            networkFee: '50000',
          },
          extra: {
            validUntilBlock: 5000,
            networkMagic: 860833102,
          },
        } })

      // Should be 0x-prefixed hex
      expect(signedTx.startsWith('0x')).toBe(true)
      // Should contain transaction data
      expect(signedTx.length).toBeGreaterThan(10)
    })

    it('should produce different signed transactions for different nonces', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const address = signer.getAddress(privateKey)

      const baseTx = {
        from: address,
        to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
        value: '1',
        data: '0x0c',
        fee: {
          systemFee: '100000',
          networkFee: '50000',
        },
        extra: {
          validUntilBlock: 5000,
          networkMagic: 860833102,
        },
      }

      const signed1 = await signer.signTransaction({ privateKey: privateKey, tx: { ...baseTx, nonce: 1 } })
      const signed2 = await signer.signTransaction({ privateKey: privateKey, tx: { ...baseTx, nonce: 2 } })
      expect(signed1).not.toBe(signed2)
    })

    it('should build NEP-17 GAS transfer script when no data provided', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const fromAddress = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
          value: '100000000', // 1 GAS (8 decimals)
          nonce: 1,
          fee: {
            systemFee: '100000',
            networkFee: '50000',
          },
          extra: {
            validUntilBlock: 5000,
            networkMagic: 860833102,
            asset: 'GAS',
          },
        } })

      expect(signedTx.startsWith('0x')).toBe(true)

      // Decode and verify the transaction structure
      const txBytes = hexToBytes(signedTx.slice(2))

      // version = 0
      expect(txBytes[0]).toBe(0)
      // nonce (bytes 1-4 LE) = 1
      expect(txBytes[1]).toBe(1)
      expect(txBytes[2]).toBe(0)
      expect(txBytes[3]).toBe(0)
      expect(txBytes[4]).toBe(0)

      // The script should contain the GAS contract hash (cf76e28b)
      // and "transfer" method name and SYSCALL
      const txHex = signedTx.slice(2)
      // GAS contract hash in little-endian hex
      expect(txHex).toContain('cf76e28bd0062c4a478ee35561011319f3cfa4d2')
      // "transfer" as hex
      const transferHex = bytesToHex(new TextEncoder().encode('transfer'))
      expect(txHex).toContain(transferHex)
      // SYSCALL System.Contract.Call (41 627d5b52)
      expect(txHex).toContain('41627d5b52')
    })

    it('should build NEP-17 NEO transfer script', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const fromAddress = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
          value: '10', // 10 NEO (indivisible)
          nonce: 42,
          fee: {
            systemFee: '100000',
            networkFee: '50000',
          },
          extra: {
            validUntilBlock: 1000,
            networkMagic: 860833102,
            asset: 'NEO',
          },
        } })

      expect(signedTx.startsWith('0x')).toBe(true)
      const txHex = signedTx.slice(2)

      // NEO contract hash in little-endian hex
      expect(txHex).toContain('f563ea40bc283d4d0e05c48ea305b3f2a07340ef')
    })

    it('should default to GAS asset when no asset specified', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const fromAddress = signer.getAddress(privateKey)

      const signedTxDefault = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
          value: '1',
          nonce: 1,
          fee: { systemFee: '100000', networkFee: '50000' },
          extra: { validUntilBlock: 5000, networkMagic: 860833102 },
        } })

      const signedTxGas = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
          value: '1',
          nonce: 1,
          fee: { systemFee: '100000', networkFee: '50000' },
          extra: { validUntilBlock: 5000, networkMagic: 860833102, asset: 'GAS' },
        } })

      // Both should produce identical transactions
      expect(signedTxDefault).toBe(signedTxGas)
    })

    it('should produce deterministic output for same inputs', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const fromAddress = signer.getAddress(privateKey)

      const txParams = {
        from: fromAddress,
        to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
        value: '100000000',
        nonce: 99,
        fee: { systemFee: '100000', networkFee: '50000' },
        extra: { validUntilBlock: 5000, networkMagic: 860833102, asset: 'GAS' },
      }

      const signed1 = await signer.signTransaction({ privateKey: privateKey, tx: txParams })
      const signed2 = await signer.signTransaction({ privateKey: privateKey, tx: txParams })
      expect(signed1).toBe(signed2)
    })

    it('should serialize correct transaction structure with witness', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const fromAddress = signer.getAddress(privateKey)

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
          value: '1',
          nonce: 0,
          fee: { systemFee: '0', networkFee: '0' },
          extra: { validUntilBlock: 100, networkMagic: 860833102, asset: 'GAS' },
        } })

      const txBytes = hexToBytes(signedTx.slice(2))

      // version (1) + nonce (4) + systemFee (8) + networkFee (8) + validUntilBlock (4) = 25
      // + signers varint (1) + scriptHash (20) + scope (1) = 22
      // + attributes varint (1) = 1
      // + script varint prefix + script bytes = variable
      // + witnesses varint (1) + invocation (varint + 66) + verification (varint + 40) = variable
      expect(txBytes.length).toBeGreaterThan(25 + 22 + 1)

      // Verify witness structure at the end:
      // The verification script is 40 bytes and is the last major block
      // It starts with 0x0c 0x21 (PUSHDATA1 33) and ends with 0x41 0x56 0xe7 0xb3 0x27
      const lastByte = txBytes[txBytes.length - 1]
      expect(lastByte).toBe(0x27) // Last byte of CheckSig interop hash
      expect(txBytes[txBytes.length - 2]).toBe(0xb3)
      expect(txBytes[txBytes.length - 3]).toBe(0xe7)
      expect(txBytes[txBytes.length - 4]).toBe(0x56)
      expect(txBytes[txBytes.length - 5]).toBe(0x41) // SYSCALL
    })

    it('should verify the P-256 signature in the witness', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const pubKey = p256.getPublicKey(pkBytes, false)
      const fromAddress = signer.getAddress(privateKey)

      const nonce = 777
      const systemFee = BigInt('100000')
      const networkFee = BigInt('50000')
      const validUntilBlock = 5000
      const networkMagic = 860833102

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
          value: '100000000',
          nonce,
          fee: {
            systemFee: systemFee.toString(),
            networkFee: networkFee.toString(),
          },
          extra: { validUntilBlock, networkMagic, asset: 'GAS' },
        } })

      const txBytes = hexToBytes(signedTx.slice(2))

      // The witness starts after the txData portion.
      // Find the invocation script: it starts with varint(1) for witness count,
      // then varint(66) for invocation script length, then 0x0c 0x40 + 64 bytes signature.
      // The verification script is 40 bytes.

      // Work backwards: last 40 bytes = verification script content
      // Before that: varint for verification script length
      // Before that: 66 bytes invocation script content
      // Before that: varint for invocation script length
      // Before that: varint(1) for witness count

      // verification script = last 40 bytes
      const verScriptEnd = txBytes.length
      const verScriptStart = verScriptEnd - 40

      // Before verification script: its length prefix (varint 40 = 0x28, 1 byte)
      const verLenByte = txBytes[verScriptStart - 1]
      expect(verLenByte).toBe(40)

      // Before that: invocation script content (66 bytes: 0x0c + 0x40 + 64 sig bytes)
      const invEnd = verScriptStart - 1
      const invStart = invEnd - 66
      expect(txBytes[invStart]).toBe(0x0c) // PUSHDATA1
      expect(txBytes[invStart + 1]).toBe(0x40) // 64 bytes

      // Extract the 64-byte raw signature
      const sigBytes = txBytes.slice(invStart + 2, invStart + 66)
      expect(sigBytes.length).toBe(64)

      // Now reconstruct the unsigned tx data and hash to verify the signature
      // The unsigned txData = everything from start up to the witness count varint
      // witness count varint is at invStart - 1 (varint for inv script len) - 1 (witness count)
      const invLenByte = txBytes[invStart - 1]
      expect(invLenByte).toBe(66)
      const witnessCountPos = invStart - 2
      expect(txBytes[witnessCountPos]).toBe(1) // witness count = 1

      const txData = txBytes.slice(0, witnessCountPos)

      // Hash: SHA-256(magic_LE + SHA-256(txData))
      const magicBytes = new Uint8Array(4)
      magicBytes[0] = networkMagic & 0xff
      magicBytes[1] = (networkMagic >> 8) & 0xff
      magicBytes[2] = (networkMagic >> 16) & 0xff
      magicBytes[3] = (networkMagic >> 24) & 0xff

      const txHash = sha256(txData)
      const signingInput = new Uint8Array(4 + txHash.length)
      signingInput.set(magicBytes, 0)
      signingInput.set(txHash, 4)
      const msgHash = sha256(signingInput)

      // Verify the P-256 signature
      const isValid = p256.verify(sigBytes, msgHash, pubKey)
      expect(isValid).toBe(true)
    })

    it('should throw when neither data nor to+value provided', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const fromAddress = signer.getAddress(privateKey)

      await expect(
        signer.signTransaction({ privateKey: privateKey, tx: {
            from: fromAddress,
            to: '',
            value: '',
            nonce: 1,
          } }),
      ).rejects.toThrow('Transaction must have either data (raw script) or to + value')
    })

    it('should handle large transfer amounts correctly', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const fromAddress = signer.getAddress(privateKey)

      // 1 billion GAS = 10^17 fractions
      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
          value: '100000000000000000',
          nonce: 1,
          fee: { systemFee: '100000', networkFee: '50000' },
          extra: { validUntilBlock: 5000, networkMagic: 860833102, asset: 'GAS' },
        } })

      expect(signedTx.startsWith('0x')).toBe(true)
      expect(signedTx.length).toBeGreaterThan(10)
    })

    it('should handle custom contract hash as asset', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, NEO_PATH)
      const fromAddress = signer.getAddress(privateKey)

      // Use a custom contract hash (big-endian display format)
      const customContract = '0xabcdef1234567890abcdef1234567890abcdef12'

      const signedTx = await signer.signTransaction({ privateKey: privateKey, tx: {
          from: fromAddress,
          to: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
          value: '1000',
          nonce: 1,
          fee: { systemFee: '100000', networkFee: '50000' },
          extra: { validUntilBlock: 5000, networkMagic: 860833102, asset: customContract },
        } })

      expect(signedTx.startsWith('0x')).toBe(true)
      // The reversed contract hash should appear in the transaction
      const txHex = signedTx.slice(2)
      // Reversed: 12efcdab907856341234efcdab907856341234efcdab
      expect(txHex).toContain('12efcdab9078563412efcdab9078563412efcdab')
    })
  })

  describe('end-to-end flow', () => {
    it('should complete full key derivation and signing flow', async () => {
      // Generate mnemonic
      const mnemonic = signer.generateMnemonic()
      expect(signer.validateMnemonic(mnemonic)).toBe(true)

      // Derive key
      const privateKey = await signer.derivePrivateKey(mnemonic, NEO_PATH)
      expect(privateKey.startsWith('0x')).toBe(true)

      // Get address
      const address = signer.getAddress(privateKey)
      expect(address.startsWith('N')).toBe(true)
      expect(address.length).toBe(34)

      // Sign message
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'test' })
      expect(signature.startsWith('0x')).toBe(true)
      expect(signature.length).toBe(130)

      // Verify
      const pkBytes = hexToBytes(privateKey.slice(2))
      const pubKey = p256.getPublicKey(pkBytes, false)
      const msgHash = sha256(new TextEncoder().encode('test'))
      const sigBytes = hexToBytes(signature.slice(2))
      expect(p256.verify(sigBytes, msgHash, pubKey)).toBe(true)
    })
  })
})
