import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SuiProvider } from '../provider.js'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

function mockRpcResponse(result: unknown) {
  return {
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result,
    }),
  }
}

describe('SuiProvider', () => {
  let provider: SuiProvider
  const testAddress = '0x' + 'a'.repeat(64)

  beforeEach(() => {
    provider = new SuiProvider({
      endpoints: ['https://fullnode.mainnet.sui.io:443'],
    })
    mockFetch.mockReset()
  })

  describe('getBalance', () => {
    it('should return SUI balance with 9 decimals', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          coinType: '0x2::sui::SUI',
          coinObjectCount: 1,
          totalBalance: '1000000000',
          lockedBalance: {},
        }),
      )

      const balance = await provider.getBalance(testAddress)

      expect(balance.address).toBe(testAddress)
      expect(balance.amount).toBe('1000000000')
      expect(balance.symbol).toBe('SUI')
      expect(balance.decimals).toBe(9)
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info for a valid digest', async () => {
      const txDigest = 'ABC123def456'
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          digest: txDigest,
          transaction: {
            data: {
              sender: testAddress,
            },
          },
          effects: {
            status: { status: 'success' },
            gasUsed: {
              computationCost: '1000000',
              storageCost: '2000000',
              storageRebate: '500000',
            },
          },
          checkpoint: '100',
          timestampMs: '1700000000000',
        }),
      )

      const tx = await provider.getTransaction(txDigest)

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe(txDigest)
      expect(tx!.from).toBe(testAddress)
      expect(tx!.status).toBe('confirmed')
      expect(tx!.fee).toBe('2500000') // 1000000 + 2000000 - 500000
      expect(tx!.blockNumber).toBe(100)
      expect(tx!.timestamp).toBe(1700000000)
    })

    it('should return null for non-existent transaction', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: 'Transaction not found' },
        }),
      })

      const tx = await provider.getTransaction('nonexistent')
      expect(tx).toBeNull()
    })

    it('should return failed status for failed transactions', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          digest: 'failed_tx',
          transaction: {
            data: {
              sender: testAddress,
            },
          },
          effects: {
            status: { status: 'failure' },
            gasUsed: {
              computationCost: '1000000',
              storageCost: '0',
              storageRebate: '0',
            },
          },
          checkpoint: '50',
          timestampMs: '1700000000000',
        }),
      )

      const tx = await provider.getTransaction('failed_tx')
      expect(tx).not.toBeNull()
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should return checkpoint info by sequence number', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          sequenceNumber: '100',
          digest: 'checkpoint_hash',
          previousDigest: 'prev_hash',
          timestampMs: '1700000000000',
          transactions: ['tx1', 'tx2'],
        }),
      )

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('checkpoint_hash')
      expect(block!.parentHash).toBe('prev_hash')
      expect(block!.timestamp).toBe(1700000000)
      expect(block!.transactions).toEqual(['tx1', 'tx2'])
    })

    it('should return null for non-existent checkpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: 'Checkpoint not found' },
        }),
      })

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates based on reference gas price', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse('1000'), // reference gas price in MIST
      )

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('SUI')
      expect(Number(fee.slow)).toBeGreaterThan(0)
      expect(Number(fee.average)).toBeGreaterThan(Number(fee.slow))
      expect(Number(fee.fast)).toBeGreaterThan(Number(fee.average))
    })
  })

  describe('getChainInfo', () => {
    it('should return Sui chain information', async () => {
      mockFetch
        .mockResolvedValueOnce(mockRpcResponse('35834a8a'))
        .mockResolvedValueOnce(mockRpcResponse('12345678'))

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Sui')
      expect(info.symbol).toBe('SUI')
      expect(info.decimals).toBe(9)
      expect(info.blockHeight).toBe(12345678)
      expect(info.chainId).toBe('35834a8a')
    })
  })

  describe('getTokenBalance', () => {
    it('should return token balance for a custom coin type', async () => {
      const coinType = '0xabcdef::mycoin::MYCOIN'
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          coinType,
          coinObjectCount: 1,
          totalBalance: '500000000',
        }),
      )

      const balance = await provider.getTokenBalance(testAddress, coinType)

      expect(balance.address).toBe(testAddress)
      expect(balance.amount).toBe('500000000')
      expect(balance.symbol).toBe('MYCOIN')
      expect(balance.decimals).toBe(9)
    })
  })

  describe('getTokenMetadata', () => {
    it('should return coin metadata', async () => {
      const coinType = '0xabcdef::mycoin::MYCOIN'
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          name: 'My Coin',
          symbol: 'MYCOIN',
          decimals: 6,
          description: 'A test coin',
        }),
      )

      const metadata = await provider.getTokenMetadata(coinType)

      expect(metadata.address).toBe(coinType)
      expect(metadata.name).toBe('My Coin')
      expect(metadata.symbol).toBe('MYCOIN')
      expect(metadata.decimals).toBe(6)
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast and return the transaction digest', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          digest: 'new_tx_digest',
          effects: { status: { status: 'success' } },
        }),
      )

      const digest = await provider.broadcastTransaction('0xserialized_tx')
      expect(digest).toBe('new_tx_digest')
    })
  })

  describe('subscribeBlocks', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse('100'))

      const unsubscribe = await provider.subscribeBlocks(() => {})
      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(
        mockRpcResponse({
          data: [],
          hasNextPage: false,
        }),
      )

      const unsubscribe = await provider.subscribeTransactions(testAddress, () => {})
      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })
})
