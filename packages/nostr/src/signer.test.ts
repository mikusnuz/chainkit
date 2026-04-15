import { describe, it, expect } from 'vitest'
import { NostrSigner, NOSTR_HD_PATH, privkeyToNsec, decodeBech32 } from './signer.js'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'

describe('NostrSigner', () => {
  const signer = new NostrSigner()

  // Well-known test mnemonic
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

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
    it('should return true for valid mnemonic', () => {
      expect(signer.validateMnemonic(testMnemonic)).toBe(true)
    })

    it('should return false for invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic phrase')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a 32-byte private key from mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      expect(typeof privateKey).toBe('string')
      // Should be 64 hex chars (32 bytes), no 0x prefix
      expect(privateKey.length).toBe(64)
      expect(/^[0-9a-f]{64}$/.test(privateKey)).toBe(true)
    })

    it('should derive the same key for the same mnemonic and path', async () => {
      const key1 = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      const key2 = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      expect(key1).toBe(key2)
    })

    it('should derive different keys for different paths', async () => {
      const key1 = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      const key2 = await signer.derivePrivateKey(testMnemonic, "m/44'/1237'/0'/0/1")
      expect(key1).not.toBe(key2)
    })
  })

  describe('getAddress', () => {
    it('should return an npub bech32 address', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      const address = signer.getAddress(privateKey)
      expect(address.startsWith('npub')).toBe(true)
    })

    it('should return the same address for the same private key', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress(privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should accept 0x-prefixed hex key', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      const addr1 = signer.getAddress(privateKey)
      const addr2 = signer.getAddress('0x' + privateKey)
      expect(addr1).toBe(addr2)
    })

    it('should throw for invalid private key length', () => {
      expect(() => signer.getAddress('deadbeef')).toThrow('Invalid private key length')
    })
  })

  describe('npub/nsec bech32 encoding', () => {
    it('should encode private key as nsec and decode back', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      const nsec = privkeyToNsec(privateKey)
      expect(nsec.startsWith('nsec')).toBe(true)

      const decoded = decodeBech32(nsec)
      expect(decoded.prefix).toBe('nsec')
      expect(decoded.hex).toBe(privateKey)
    })

    it('should decode npub back to hex pubkey', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      const npub = signer.getAddress(privateKey)

      const decoded = decodeBech32(npub)
      expect(decoded.prefix).toBe('npub')
      expect(decoded.hex.length).toBe(64) // 32 bytes hex
    })

    it('should accept nsec as private key input', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      const nsec = privkeyToNsec(privateKey)

      const addrFromHex = signer.getAddress(privateKey)
      const addrFromNsec = signer.getAddress(nsec)
      expect(addrFromHex).toBe(addrFromNsec)
    })
  })

  describe('signMessage', () => {
    it('should produce a valid schnorr signature', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      const message = 'Hello, Nostr!'
      const signature = await signer.signMessage(message, privateKey)

      // Schnorr signature is 64 bytes = 128 hex chars
      expect(signature.length).toBe(128)
      expect(/^[0-9a-f]{128}$/.test(signature)).toBe(true)

      // Verify the signature
      const pkBytes = hexToBytes(privateKey)
      const xOnlyPubkey = schnorr.getPublicKey(pkBytes)
      const msgHash = sha256(new TextEncoder().encode(message))
      const isValid = schnorr.verify(
        hexToBytes(signature),
        msgHash,
        xOnlyPubkey,
      )
      expect(isValid).toBe(true)
    })

    it('should produce different signatures for different messages', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      const sig1 = await signer.signMessage('message one', privateKey)
      const sig2 = await signer.signMessage('message two', privateKey)
      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)
      const msgBytes = new Uint8Array([1, 2, 3, 4, 5])
      const signature = await signer.signMessage(msgBytes, privateKey)
      expect(signature.length).toBe(128)
    })
  })

  describe('signTransaction (Nostr event)', () => {
    it('should sign a Nostr event and return valid JSON', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)

      const tx = {
        from: signer.getAddress(privateKey),
        to: 'npub1target',
        value: '0',
        extra: {
          kind: 1,
          content: 'Hello from ChainKit!',
          tags: [['p', 'deadbeef'.repeat(8)]],
        },
      }

      const signedEventJson = await signer.signTransaction(tx, privateKey)
      const event = JSON.parse(signedEventJson)

      // Verify event structure
      expect(event.id).toBeDefined()
      expect(event.id.length).toBe(64)
      expect(event.pubkey).toBeDefined()
      expect(event.pubkey.length).toBe(64)
      expect(event.created_at).toBeDefined()
      expect(typeof event.created_at).toBe('number')
      expect(event.kind).toBe(1)
      expect(event.content).toBe('Hello from ChainKit!')
      expect(event.tags).toEqual([['p', 'deadbeef'.repeat(8)]])
      expect(event.sig).toBeDefined()
      expect(event.sig.length).toBe(128)
    })

    it('should produce a verifiable schnorr signature on the event ID', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)

      const tx = {
        from: signer.getAddress(privateKey),
        to: '',
        value: '0',
        extra: {
          kind: 1,
          content: 'Test event',
          tags: [],
        },
      }

      const signedEventJson = await signer.signTransaction(tx, privateKey)
      const event = JSON.parse(signedEventJson)

      // Verify the event ID is correct per NIP-01
      const serialized = JSON.stringify([
        0,
        event.pubkey,
        event.created_at,
        event.kind,
        event.tags,
        event.content,
      ])
      const expectedId = bytesToHex(sha256(new TextEncoder().encode(serialized)))
      expect(event.id).toBe(expectedId)

      // Verify the schnorr signature
      const isValid = schnorr.verify(
        hexToBytes(event.sig),
        hexToBytes(event.id),
        hexToBytes(event.pubkey),
      )
      expect(isValid).toBe(true)
    })

    it('should throw if extra does not contain valid NostrEventData', async () => {
      const privateKey = await signer.derivePrivateKey(testMnemonic, NOSTR_HD_PATH)

      const tx = {
        from: '',
        to: '',
        value: '0',
      }

      await expect(signer.signTransaction(tx, privateKey)).rejects.toThrow(
        'Nostr transaction requires extra.kind',
      )
    })
  })

  describe('HD path constant', () => {
    it('should use the correct NIP-06 path', () => {
      expect(NOSTR_HD_PATH).toBe("m/44'/1237'/0'/0/0")
    })
  })
})
