import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SolanaProvider } from '../provider.js'

/**
 * Mock fetch globally for RPC tests.
 * Each test configures specific mock responses.
 */
function mockRpcResponse(result: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ jsonrpc: '2.0', result }),
  })
}

function mockRpcSequence(results: unknown[]) {
  let callIndex = 0
  return vi.fn().mockImplementation(() => {
    const result = results[callIndex % results.length]
    callIndex++
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', result }),
    })
  })
}

function mockRpcError(code: number, message: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ jsonrpc: '2.0', error: { code, message } }),
  })
}

const TEST_ADDRESS = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const TEST_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TEST_SIGNATURE = '5TvRYtLBm6F3JMPFHFrKrGKT2BnFZKcVjMEeMqqRM3k9WHkuWCv2zcF3qRBCJXNqNrYfd8Ae4wZ3BGfFLdFbCR6q'

describe('SolanaProvider', () => {
  let provider: SolanaProvider
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    provider = new SolanaProvider({
      endpoints: ['https://api.mainnet-beta.solana.com'],
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('getBalance', () => {
    it('should return SOL balance for an address', async () => {
      globalThis.fetch = mockRpcResponse({ value: 1500000000 }) as typeof fetch

      const balance = await provider.getBalance(TEST_ADDRESS)

      expect(balance.address).toBe(TEST_ADDRESS)
      expect(balance.amount).toBe('1500000000')
      expect(balance.symbol).toBe('SOL')
      expect(balance.decimals).toBe(9)
    })

    it('should return zero balance', async () => {
      globalThis.fetch = mockRpcResponse({ value: 0 }) as typeof fetch

      const balance = await provider.getBalance(TEST_ADDRESS)
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction details', async () => {
      globalThis.fetch = mockRpcResponse({
        slot: 123456789,
        blockTime: 1700000000,
        meta: {
          err: null,
          fee: 5000,
          preBalances: [10000000000, 0],
          postBalances: [8999995000, 1000000000],
        },
        transaction: {
          message: {
            accountKeys: [
              { pubkey: TEST_ADDRESS },
              { pubkey: '11111111111111111111111111111111' },
            ],
          },
        },
      }) as typeof fetch

      const tx = await provider.getTransaction(TEST_SIGNATURE)

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe(TEST_SIGNATURE)
      expect(tx!.from).toBe(TEST_ADDRESS)
      expect(tx!.to).toBe('11111111111111111111111111111111')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.fee).toBe('5000')
      expect(tx!.value).toBe('1000000000')
      expect(tx!.blockNumber).toBe(123456789)
      expect(tx!.timestamp).toBe(1700000000)
    })

    it('should return null for non-existent transaction', async () => {
      globalThis.fetch = mockRpcResponse(null) as typeof fetch

      const tx = await provider.getTransaction('nonexistent')
      expect(tx).toBeNull()
    })

    it('should handle failed transactions', async () => {
      globalThis.fetch = mockRpcResponse({
        slot: 123456789,
        blockTime: 1700000000,
        meta: {
          err: { InstructionError: [0, 'Custom'] },
          fee: 5000,
          preBalances: [10000000000, 0],
          postBalances: [9999995000, 0],
        },
        transaction: {
          message: {
            accountKeys: [TEST_ADDRESS, '11111111111111111111111111111111'],
          },
        },
      }) as typeof fetch

      const tx = await provider.getTransaction(TEST_SIGNATURE)

      expect(tx).not.toBeNull()
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should return block details for a slot number', async () => {
      globalThis.fetch = mockRpcResponse({
        blockhash: 'DvLEyV2GHk86K5GojpqnRsvhfMF5kdZomKMnhVpvnQxB',
        previousBlockhash: 'CdYGdnEBgMdq7PKwjXLriXyVVD6ZfY8pLb4pHqtYPFRS',
        blockTime: 1700000000,
        signatures: [TEST_SIGNATURE],
      }) as typeof fetch

      const block = await provider.getBlock(123456789)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(123456789)
      expect(block!.hash).toBe('DvLEyV2GHk86K5GojpqnRsvhfMF5kdZomKMnhVpvnQxB')
      expect(block!.parentHash).toBe('CdYGdnEBgMdq7PKwjXLriXyVVD6ZfY8pLb4pHqtYPFRS')
      expect(block!.timestamp).toBe(1700000000)
      expect(block!.transactions).toContain(TEST_SIGNATURE)
    })

    it('should return null for non-existent slot', async () => {
      globalThis.fetch = mockRpcResponse(null) as typeof fetch

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })

    it('should accept string slot number', async () => {
      globalThis.fetch = mockRpcResponse({
        blockhash: 'abc123',
        previousBlockhash: 'def456',
        blockTime: 1700000000,
        signatures: [],
      }) as typeof fetch

      const block = await provider.getBlock('123456789')
      expect(block).not.toBeNull()
      expect(block!.number).toBe(123456789)
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates with priority fees', async () => {
      globalThis.fetch = mockRpcResponse([
        { prioritizationFee: 100, slot: 1 },
        { prioritizationFee: 500, slot: 2 },
        { prioritizationFee: 1000, slot: 3 },
        { prioritizationFee: 0, slot: 4 },
      ]) as typeof fetch

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('lamports')
      expect(Number(fee.slow)).toBeGreaterThanOrEqual(5000)
      expect(Number(fee.average)).toBeGreaterThanOrEqual(Number(fee.slow))
      expect(Number(fee.fast)).toBeGreaterThanOrEqual(Number(fee.average))
    })

    it('should return default fees when no priority fees available', async () => {
      globalThis.fetch = mockRpcResponse([]) as typeof fetch

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('lamports')
      expect(fee.slow).toBe('5000')
      expect(fee.average).toBe('5000')
      expect(fee.fast).toBe('10000')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a transaction and return signature', async () => {
      globalThis.fetch = mockRpcResponse(TEST_SIGNATURE) as typeof fetch

      const result = await provider.broadcastTransaction('base64encodedtx==')
      expect(result).toBe(TEST_SIGNATURE)
    })
  })

  describe('getChainInfo', () => {
    it('should return mainnet info', async () => {
      globalThis.fetch = mockRpcSequence([
        { 'solana-core': '1.18.0', 'feature-set': 123456 },
        300000000,
        '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      ]) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
      expect(info.name).toBe('Solana Mainnet')
      expect(info.symbol).toBe('SOL')
      expect(info.decimals).toBe(9)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(300000000)
    })

    it('should detect devnet', async () => {
      globalThis.fetch = mockRpcSequence([
        { 'solana-core': '1.18.0', 'feature-set': 123456 },
        100000000,
        'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      ]) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Solana Devnet')
      expect(info.testnet).toBe(true)
    })

    it('should detect testnet', async () => {
      globalThis.fetch = mockRpcSequence([
        { 'solana-core': '1.18.0', 'feature-set': 123456 },
        100000000,
        '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
      ]) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Solana Testnet')
      expect(info.testnet).toBe(true)
    })
  })

  describe('getTokenBalance', () => {
    it('should return SPL token balance', async () => {
      globalThis.fetch = mockRpcResponse({
        value: [
          {
            pubkey: 'tokenAccountPubkey123',
            account: {
              data: {
                parsed: {
                  info: {
                    tokenAmount: {
                      amount: '1000000',
                      decimals: 6,
                      uiAmountString: '1.0',
                    },
                    mint: TEST_MINT,
                  },
                },
              },
            },
          },
        ],
      }) as typeof fetch

      const balance = await provider.getTokenBalance(TEST_ADDRESS, TEST_MINT)

      expect(balance.address).toBe(TEST_ADDRESS)
      expect(balance.amount).toBe('1000000')
      expect(balance.decimals).toBe(6)
    })

    it('should return zero for non-existent token account', async () => {
      globalThis.fetch = mockRpcResponse({ value: [] }) as typeof fetch

      const balance = await provider.getTokenBalance(TEST_ADDRESS, TEST_MINT)

      expect(balance.amount).toBe('0')
      expect(balance.decimals).toBe(0)
    })
  })

  describe('getTokenMetadata', () => {
    it('should return SPL token metadata', async () => {
      globalThis.fetch = mockRpcResponse({
        value: {
          data: {
            parsed: {
              info: {
                decimals: 6,
                supply: '1000000000000',
                mintAuthority: TEST_ADDRESS,
              },
            },
          },
        },
      }) as typeof fetch

      const metadata = await provider.getTokenMetadata(TEST_MINT)

      expect(metadata.address).toBe(TEST_MINT)
      expect(metadata.decimals).toBe(6)
      expect(metadata.totalSupply).toBe('1000000000000')
    })

    it('should throw for non-existent mint', async () => {
      globalThis.fetch = mockRpcResponse({ value: null }) as typeof fetch

      await expect(provider.getTokenMetadata('nonexistent')).rejects.toThrow(
        'Token mint not found',
      )
    })
  })

  describe('callContract (simulateTransaction)', () => {
    it('should simulate a transaction', async () => {
      globalThis.fetch = mockRpcResponse({
        value: {
          err: null,
          logs: ['Program log: result'],
          accounts: null,
          unitsConsumed: 50000,
        },
      }) as typeof fetch

      const result = await provider.callContract(
        '11111111111111111111111111111111',
        'base64EncodedTx==',
      )

      expect(result).toBeDefined()
      expect((result as Record<string, unknown>).err).toBeNull()
    })

    it('should throw on simulation failure', async () => {
      globalThis.fetch = mockRpcResponse({
        value: {
          err: { InstructionError: [0, 'Custom'] },
          logs: [],
          accounts: null,
          unitsConsumed: 0,
        },
      }) as typeof fetch

      await expect(
        provider.callContract('11111111111111111111111111111111', 'base64EncodedTx=='),
      ).rejects.toThrow('Simulation failed')
    })
  })

  describe('estimateGas (compute units)', () => {
    it('should return compute units from simulation', async () => {
      globalThis.fetch = mockRpcResponse({
        value: {
          err: null,
          logs: [],
          accounts: null,
          unitsConsumed: 75000,
        },
      }) as typeof fetch

      const gas = await provider.estimateGas(
        '11111111111111111111111111111111',
        'base64EncodedTx==',
      )

      expect(gas).toBe('75000')
    })

    it('should return default compute units when not available', async () => {
      globalThis.fetch = mockRpcResponse({
        value: {
          err: null,
          logs: [],
          accounts: null,
        },
      }) as typeof fetch

      const gas = await provider.estimateGas(
        '11111111111111111111111111111111',
        'base64EncodedTx==',
      )

      expect(gas).toBe('200000')
    })
  })

  describe('subscribeBlocks', () => {
    it('should call callback with new slot numbers', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ jsonrpc: '2.0', id: callCount, result: 100 + callCount }),
        })
      }) as typeof fetch

      const received: number[] = []
      const unsubscribe = await provider.subscribeBlocks((slot) => {
        received.push(slot)
      })

      // Wait a bit for polling
      await new Promise((resolve) => setTimeout(resolve, 100))

      unsubscribe()

      expect(received.length).toBeGreaterThanOrEqual(1)
      expect(received[0]).toBeGreaterThan(0)
    })
  })

  describe('subscribeTransactions', () => {
    it('should subscribe and unsubscribe without error', async () => {
      globalThis.fetch = mockRpcResponse([]) as typeof fetch

      const unsubscribe = await provider.subscribeTransactions(
        TEST_ADDRESS,
        () => {},
      )

      // Give it a moment to start polling
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should not throw
      unsubscribe()
    })
  })
})
