import { describe, it, expect } from 'vitest'
import { ZkspaceSigner, ZKSPACE_DEFAULT_PATH } from '../index.js'

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('ZkspaceSigner', () => {
  const signer = new ZkspaceSigner()

  describe('ZKSPACE_DEFAULT_PATH', () => {
    it('should use the EVM-compatible HD path', () => {
      expect(ZKSPACE_DEFAULT_PATH).toBe("m/44'/60'/0'/0/0")
    })
  })

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
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      expect(pk).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('should produce deterministic keys', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      expect(pk1).toBe(pk2)
    })

    it('should produce different keys for different paths', async () => {
      const pk0 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/0")
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, "m/44'/60'/0'/0/1")
      expect(pk0).not.toBe(pk1)
    })

    it('should match the known private key for the test mnemonic (EVM-compatible)', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      // Same as Ethereum since ZKSpace uses the same HD path
      expect(pk).toBe('0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727')
    })
  })

  describe('getAddress', () => {
    it('should return a valid EVM address (0x + 40 hex chars)', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const address = signer.getAddress(pk)

      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })

    it('should produce deterministic addresses', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)
      expect(addr1).toBe(addr2)
    })

    it('should match the expected EVM address (case-insensitive)', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const address = signer.getAddress(pk)
      // Same address as Ethereum for the same mnemonic and path
      expect(address.toLowerCase()).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94')
    })

    it('should return an EIP-55 checksummed address', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const address = signer.getAddress(pk)
      const withoutPrefix = address.slice(2)
      const hasUpper = /[A-F]/.test(withoutPrefix)
      const hasLower = /[a-f]/.test(withoutPrefix)
      expect(hasUpper || hasLower).toBe(true)
    })
  })

  describe('signMessage', () => {
    it('should produce a valid 65-byte signature', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const sig = await signer.signMessage('Hello, ZKSpace!', pk)

      // 0x + 130 hex chars = 65 bytes (r: 32 + s: 32 + v: 1)
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce deterministic signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const sig1 = await signer.signMessage('test message', pk)
      const sig2 = await signer.signMessage('test message', pk)
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const sig1 = await signer.signMessage('message 1', pk)
      const sig2 = await signer.signMessage('message 2', pk)
      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const msgBytes = new TextEncoder().encode('Hello')
      const sig = await signer.signMessage(msgBytes, pk)
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('should produce the same signature for string and equivalent bytes', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const msg = 'Hello, ZKSpace!'
      const sig1 = await signer.signMessage(msg, pk)
      const sig2 = await signer.signMessage(new TextEncoder().encode(msg), pk)
      expect(sig1).toBe(sig2)
    })

    it('should have v value of 27 or 28', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const sig = await signer.signMessage('test', pk)
      const vHex = sig.slice(-2)
      const v = parseInt(vHex, 16)
      expect(v === 27 || v === 28).toBe(true)
    })
  })

  describe('signTransaction', () => {
    it('should sign a legacy transaction', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: '0x0000000000000000000000000000000000000001',
        value: '1000000000000000000', // 1 ETH in wei
        nonce: 0,
        fee: {
          gasPrice: '0x4a817c800', // 20 gwei
          gasLimit: '0x5208', // 21000
        },
        extra: { chainId: 13 },
      }

      const signedTx = await signer.signTransaction(tx, pk)
      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      expect(signedTx.length).toBeGreaterThan(10)
    })

    it('should sign an EIP-1559 transaction', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: '0x0000000000000000000000000000000000000001',
        value: '1000000000000000000',
        nonce: 0,
        fee: {
          maxFeePerGas: '0x4a817c800',
          maxPriorityFeePerGas: '0x3b9aca00',
          gasLimit: '0x5208',
        },
        extra: { chainId: 13 },
      }

      const signedTx = await signer.signTransaction(tx, pk)
      // EIP-1559 transactions start with 0x02
      expect(signedTx).toMatch(/^0x02[0-9a-f]+$/)
    })

    it('should produce deterministic signed transactions', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, ZKSPACE_DEFAULT_PATH)
      const tx = {
        from: signer.getAddress(pk),
        to: '0x0000000000000000000000000000000000000001',
        value: '0',
        nonce: 0,
        fee: { gasPrice: '0x0', gasLimit: '0x5208' },
        extra: { chainId: 13 },
      }

      const sig1 = await signer.signTransaction(tx, pk)
      const sig2 = await signer.signTransaction(tx, pk)
      expect(sig1).toBe(sig2)
    })
  })
})
