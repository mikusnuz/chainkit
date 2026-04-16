/**
 * Integration test for Hedera JSON-RPC Relay.
 *
 * Tests against the live Hedera testnet relay (https://testnet.hashio.io/api).
 * Skips tests that require funded accounts when no balance is available.
 *
 * Account info:
 * - ED25519 account: 0.0.8665888 (EVM: 0x0000000000000000000000000000000000843b20) - has 100 HBAR
 * - ECDSA address derived from mnemonic: 0x6E45C91fD4fac4fE1d52C2CE3A033070f7814613
 * - The ED25519 account cannot sign EVM transactions (needs secp256k1)
 * - The ECDSA address needs HBAR to send transactions
 */
import { describe, it, expect } from 'vitest'
import { HederaEcdsaSigner, HEDERA_ECDSA_PATH } from '../signer.js'
import { HederaRelayProvider } from '../provider.js'

const RELAY_URL = 'https://testnet.hashio.io/api'
const MIRROR_URL = 'https://testnet.mirrornode.hedera.com'

const MNEMONIC =
  'birth bacon antenna hurry eagle exclude hunt globe arctic clinic trash lens ridge about disease debris fine throw chef entire still erase law elder'

// ED25519 account with 100 HBAR (cannot use with EVM relay)
const ED25519_ACCOUNT = '0.0.8665888'
const ED25519_EVM_ADDRESS = '0x0000000000000000000000000000000000843b20'

// Expected ECDSA address derived from the mnemonic at m/44'/60'/0'/0/0
const EXPECTED_ECDSA_ADDRESS = '0x6E45C91fD4fac4fE1d52C2CE3A033070f7814613'

describe('Hedera Relay Integration', { timeout: 30000 }, () => {
  const signer = new HederaEcdsaSigner()
  const provider = new HederaRelayProvider({
    relayUrl: RELAY_URL,
    mirrorNodeUrl: MIRROR_URL,
  })

  describe('Key derivation', () => {
    it('should derive the correct ECDSA address from the mnemonic', async () => {
      const privateKey = await signer.derivePrivateKey(MNEMONIC, HEDERA_ECDSA_PATH)
      const address = signer.getAddress(privateKey)
      expect(address).toBe(EXPECTED_ECDSA_ADDRESS)
    })
  })

  describe('Chain info via relay', () => {
    it('should get Hedera Testnet chain info', async () => {
      const info = await provider.getChainInfo()
      expect(info.chainId).toBe('296')
      expect(info.name).toBe('Hedera Testnet')
      expect(info.symbol).toBe('HBAR')
      expect(info.testnet).toBe(true)
      expect(info.blockHeight).toBeGreaterThan(0)
    })
  })

  describe('Balance queries via relay', () => {
    it('should get ED25519 account balance via relay (100 HBAR)', async () => {
      const balance = await provider.getBalance(ED25519_EVM_ADDRESS)
      expect(balance.symbol).toBe('HBAR')
      expect(balance.decimals).toBe(18)
      // 100 HBAR = 100 * 10^18 weibars
      expect(BigInt(balance.amount)).toBe(100000000000000000000n)
    })

    it('should get ECDSA address balance via relay', async () => {
      const balance = await provider.getBalance(EXPECTED_ECDSA_ADDRESS)
      expect(balance.symbol).toBe('HBAR')
      expect(balance.decimals).toBe(18)
      // May or may not have balance
    })
  })

  describe('Nonce queries via relay', () => {
    it('should get nonce for ED25519 account', async () => {
      const nonce = await provider.getNonce(ED25519_EVM_ADDRESS)
      expect(nonce).toBe(0)
    })

    it('should get nonce for ECDSA address', async () => {
      const nonce = await provider.getNonce(EXPECTED_ECDSA_ADDRESS)
      expect(typeof nonce).toBe('number')
    })
  })

  describe('Gas price via relay', () => {
    it('should get gas price from the relay', async () => {
      const fee = await provider.estimateFee()
      expect(fee.unit).toBe('weibars')
      expect(BigInt(fee.slow)).toBeGreaterThan(0n)
    })
  })

  describe('Mirror node lookups', () => {
    it('should look up EVM address for the ED25519 account', async () => {
      const evmAddress = await provider.lookupEvmAddress(ED25519_ACCOUNT)
      expect(evmAddress).toBe(ED25519_EVM_ADDRESS)
    })

    it('should get account key type for the ED25519 account', async () => {
      const keyInfo = await provider.getAccountKeyType(ED25519_ACCOUNT)
      expect(keyInfo).not.toBeNull()
      expect(keyInfo!.type).toBe('ED25519')
    })
  })

  describe('Block queries via relay', () => {
    it('should get the latest block', async () => {
      const block = await provider.getBlock('latest')
      expect(block).not.toBeNull()
      expect(block!.number).toBeGreaterThan(0)
      expect(block!.hash).toMatch(/^0x[0-9a-f]+$/)
    })
  })

  describe('Transaction signing', () => {
    it('should produce a valid signed legacy transaction', async () => {
      const privateKey = await signer.derivePrivateKey(MNEMONIC, HEDERA_ECDSA_PATH)
      const nonce = await provider.getNonce(EXPECTED_ECDSA_ADDRESS)
      const fee = await provider.estimateFee()
      const gasPrice = BigInt(fee.average)

      const signedTx = await signer.signTransaction({
        privateKey,
        tx: {
          to: ED25519_EVM_ADDRESS,
          value: '1000000000000000000', // 1 HBAR
          nonce,
          fee: {
            gasPrice: '0x' + gasPrice.toString(16),
            gasLimit: '0xC350', // 50000
          },
          extra: { chainId: 296 },
        },
      })

      expect(signedTx).toMatch(/^0x[0-9a-f]+$/)
      // Legacy transactions start with 0xf8 or higher
      expect(parseInt(signedTx.slice(2, 4), 16)).toBeGreaterThanOrEqual(0xc0)
    })

    it('should produce a valid signed EIP-1559 transaction', async () => {
      const privateKey = await signer.derivePrivateKey(MNEMONIC, HEDERA_ECDSA_PATH)
      const nonce = await provider.getNonce(EXPECTED_ECDSA_ADDRESS)
      const fee = await provider.estimateFee()
      const gasPrice = BigInt(fee.average)

      const signedTx = await signer.signTransaction({
        privateKey,
        tx: {
          to: ED25519_EVM_ADDRESS,
          value: '1000000000000000000', // 1 HBAR
          nonce,
          fee: {
            maxFeePerGas: '0x' + gasPrice.toString(16),
            maxPriorityFeePerGas: '0x0',
            gasLimit: '0xC350',
          },
          extra: { chainId: 296 },
        },
      })

      expect(signedTx).toMatch(/^0x02/) // EIP-1559 prefix
    })
  })

  describe('Transaction broadcast', () => {
    it('should attempt to broadcast (may fail due to no balance)', async () => {
      const privateKey = await signer.derivePrivateKey(MNEMONIC, HEDERA_ECDSA_PATH)
      const balance = await provider.getBalance(EXPECTED_ECDSA_ADDRESS)

      if (BigInt(balance.amount) === 0n) {
        // No balance -- build and sign but expect broadcast to fail
        const fee = await provider.estimateFee()
        const gasPrice = BigInt(fee.average)

        const signedTx = await signer.signTransaction({
          privateKey,
          tx: {
            to: ED25519_EVM_ADDRESS,
            value: '100000000000000000', // 0.1 HBAR
            nonce: 0,
            fee: {
              gasPrice: '0x' + gasPrice.toString(16),
              gasLimit: '0xC350',
            },
            extra: { chainId: 296 },
          },
        })

        // Broadcasting should fail because the ECDSA address has no HBAR
        await expect(provider.broadcastTransaction(signedTx)).rejects.toThrow()
        return
      }

      // If balance exists, actually send a small transaction
      const nonce = await provider.getNonce(EXPECTED_ECDSA_ADDRESS)
      const fee = await provider.estimateFee()
      const gasPrice = BigInt(fee.average)

      const signedTx = await signer.signTransaction({
        privateKey,
        tx: {
          to: ED25519_EVM_ADDRESS,
          value: '100000000000000000', // 0.1 HBAR
          nonce,
          fee: {
            gasPrice: '0x' + gasPrice.toString(16),
            gasLimit: '0xC350',
          },
          extra: { chainId: 296 },
        },
      })

      const txHash = await provider.broadcastTransaction(signedTx)
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/)

      // Wait for confirmation
      const txInfo = await provider.waitForTransaction(txHash, { timeout: 20000, interval: 2000 })
      expect(txInfo.status).toBe('confirmed')
    })
  })
})
