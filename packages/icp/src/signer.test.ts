import { describe, it, expect } from 'vitest'
import {
  IcpSigner,
  derEncodePublicKey,
  derivePrincipal,
  deriveAccountId,
  principalToText,
} from './index.js'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'

// Ensure ed25519 sha512 is set for tests
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const ICP_PATH = "m/44'/223'/0'/0'/0'"

describe('IcpSigner', () => {
  const signer = new IcpSigner()

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
      expect(signer.validateMnemonic('invalid mnemonic words here')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key from mnemonic using ICP path', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)

      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should derive the same key for the same mnemonic and path', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)

      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const key2 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/223'/0'/0'/1'")

      expect(key1).not.toBe(key2)
    })

    it('should reject non-hardened paths for ED25519', async () => {
      await expect(
        signer.derivePrivateKey(TEST_MNEMONIC, 'm/44/223/0/0/0'),
      ).rejects.toThrow(/hardened/)
    })
  })

  describe('getAddress', () => {
    it('should return a 64-character hex string (account identifier)', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const address = signer.getAddress(privateKey)

      // Account identifier: 32 bytes = 64 hex chars
      expect(address).toMatch(/^[0-9a-f]{64}$/)
    })

    it('should return the same address for the same private key', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)

      expect(addr1).toBe(addr2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('0x1234')).toThrow(/Invalid private key length/)
    })
  })

  describe('getPrincipalId', () => {
    it('should return a dashed textual principal ID', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const principalId = signer.getPrincipalId(privateKey)

      // Principal text format: groups of 5 lowercase alphanumeric chars separated by dashes
      expect(principalId).toMatch(/^[a-z2-7]+(-[a-z2-7]+)*$/)
    })

    it('should be deterministic', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const pid1 = signer.getPrincipalId(privateKey)
      const pid2 = signer.getPrincipalId(privateKey)

      expect(pid1).toBe(pid2)
    })
  })

  describe('signTransaction', () => {
    it('should sign transaction data and return a 128-char hex signature', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const tx = {
        from: signer.getAddress(privateKey),
        to: 'a'.repeat(64),
        value: '100000000',
        data: '0x' + bytesToHex(new TextEncoder().encode('test transaction')),
      }

      const signature = await signer.signTransaction({ privateKey: privateKey, tx: tx })

      // ED25519 signature: 64 bytes = 128 hex chars + '0x' prefix
      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce verifiable ED25519 signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const message = new TextEncoder().encode('test message')
      const tx = {
        from: signer.getAddress(privateKey),
        to: 'b'.repeat(64),
        value: '0',
        data: '0x' + bytesToHex(message),
      }

      const signature = await signer.signTransaction({ privateKey: privateKey, tx: tx })
      const sigBytes = hexToBytes(signature.slice(2))

      const isValid = ed25519.verify(sigBytes, message, publicKey)
      expect(isValid).toBe(true)
    })

    it('should throw if tx.data is missing', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const tx = {
        from: signer.getAddress(privateKey),
        to: 'c'.repeat(64),
        value: '0',
      }

      await expect(signer.signTransaction({ privateKey: privateKey, tx: tx })).rejects.toThrow(/data.*required/i)
    })
  })

  describe('signMessage', () => {
    it('should sign a string message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const signature = await signer.signMessage({ privateKey: privateKey, message: 'hello ICP' })

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should sign a Uint8Array message', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage({ privateKey: privateKey, message: message })

      expect(signature).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it('should produce verifiable signatures', async () => {
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)

      const message = 'verify me'
      const signature = await signer.signMessage({ privateKey: privateKey, message: message })
      const sigBytes = hexToBytes(signature.slice(2))
      const msgBytes = new TextEncoder().encode(message)

      const isValid = ed25519.verify(sigBytes, msgBytes, publicKey)
      expect(isValid).toBe(true)
    })
  })
})

describe('ICP Crypto Utilities', () => {
  describe('derEncodePublicKey', () => {
    it('should produce a 44-byte DER-encoded key from a 32-byte public key', () => {
      const publicKey = new Uint8Array(32).fill(1)
      const der = derEncodePublicKey(publicKey)

      expect(der.length).toBe(44)
      // Check DER prefix bytes
      expect(der[0]).toBe(0x30)
      expect(der[1]).toBe(0x2a)
      // Last 32 bytes should be the public key
      expect(der.slice(12)).toEqual(publicKey)
    })
  })

  describe('derivePrincipal', () => {
    it('should produce a 29-byte principal', () => {
      const publicKey = new Uint8Array(32).fill(0xab)
      const principal = derivePrincipal(publicKey)

      expect(principal.length).toBe(29)
      // Last byte should be 0x02 (self-authenticating tag)
      expect(principal[28]).toBe(0x02)
    })
  })

  describe('deriveAccountId', () => {
    it('should produce a 64-character hex string', () => {
      const principal = new Uint8Array(29).fill(0x01)
      principal[28] = 0x02
      const accountId = deriveAccountId(principal)

      expect(accountId).toMatch(/^[0-9a-f]{64}$/)
    })

    it('should produce different account IDs for different subaccounts', () => {
      const principal = new Uint8Array(29).fill(0x01)
      principal[28] = 0x02

      const defaultId = deriveAccountId(principal)
      const subaccount = new Uint8Array(32)
      subaccount[31] = 1
      const subId = deriveAccountId(principal, subaccount)

      expect(defaultId).not.toBe(subId)
    })

    it('should throw for invalid subaccount length', () => {
      const principal = new Uint8Array(29).fill(0x01)
      const badSubaccount = new Uint8Array(16)

      expect(() => deriveAccountId(principal, badSubaccount)).toThrow(/Subaccount must be 32 bytes/)
    })
  })

  describe('principalToText', () => {
    it('should return a dashed lowercase string', () => {
      const principal = new Uint8Array(29).fill(0x01)
      principal[28] = 0x02
      const text = principalToText(principal)

      expect(text).toMatch(/^[a-z2-7]+(-[a-z2-7]+)*$/)
    })

    it('should be deterministic', () => {
      const principal = new Uint8Array(29).fill(0xab)
      principal[28] = 0x02

      const text1 = principalToText(principal)
      const text2 = principalToText(principal)

      expect(text1).toBe(text2)
    })
  })

  describe('end-to-end key derivation', () => {
    it('should produce consistent address from mnemonic', async () => {
      const signer = new IcpSigner()
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)

      // Derive address via signer
      const address = signer.getAddress(privateKey)

      // Manually derive and verify
      const pkBytes = hexToBytes(privateKey.slice(2))
      const publicKey = ed25519.getPublicKey(pkBytes)
      const principal = derivePrincipal(publicKey)
      const manualAccountId = deriveAccountId(principal)

      expect(address).toBe(manualAccountId)
    })

    it('should produce valid principal from mnemonic', async () => {
      const signer = new IcpSigner()
      const privateKey = await signer.derivePrivateKey(TEST_MNEMONIC, ICP_PATH)

      const principalId = signer.getPrincipalId(privateKey)

      // Should end with "cai" or "qai" or similar IC principal suffix
      expect(principalId.length).toBeGreaterThan(10)
      // Should contain dashes
      expect(principalId).toContain('-')
    })
  })
})
