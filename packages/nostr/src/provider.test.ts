import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NostrProvider } from './provider.js'

// Mock fetch for RPC calls
const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

function mockRpcResponse(result: unknown) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  }
}

function mockRpcError(code: number, message: string) {
  return {
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      error: { code, message },
    }),
  }
}

describe('NostrProvider', () => {
  let provider: NostrProvider

  beforeEach(() => {
    mockFetch.mockReset()
    provider = new NostrProvider({
      endpoints: ['https://relay.example.com'],
      pollInterval: 1000,
    })
  })

  describe('getBalance', () => {
    it('should return balance from relay', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({ balance: '100000' }),
      )

      const balance = await provider.getBalance('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
      expect(balance.symbol).toBe('SAT')
      expect(balance.decimals).toBe(0)
      expect(balance.amount).toBe('100000')
      expect(balance.address).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    })

    it('should return zero balance on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'))

      const balance = await provider.getBalance('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
      expect(balance.amount).toBe('0')
      expect(balance.symbol).toBe('SAT')
    })

    it('should return zero when relay returns null', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse(null))

      const balance = await provider.getBalance('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return event as TransactionInfo', async () => {
      const mockEvent = {
        id: 'abc123'.padEnd(64, '0'),
        pubkey: 'sender'.padEnd(64, '0'),
        created_at: 1700000000,
        kind: 1,
        tags: [
          ['p', 'recipient'.padEnd(64, '0')],
          ['amount', '5000'],
        ],
        content: 'test content',
        sig: 'sig'.padEnd(128, '0'),
      }

      mockFetch.mockResolvedValueOnce(mockRpcResponse(mockEvent))

      const tx = await provider.getTransaction('abc123'.padEnd(64, '0'))
      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('abc123'.padEnd(64, '0'))
      expect(tx!.from).toBe('sender'.padEnd(64, '0'))
      expect(tx!.to).toBe('recipient'.padEnd(64, '0'))
      expect(tx!.value).toBe('5000')
      expect(tx!.fee).toBe('0')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.timestamp).toBe(1700000000)
      expect(tx!.blockNumber).toBeNull()
    })

    it('should return null for non-existent event', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse(null))

      const tx = await provider.getTransaction('nonexistent')
      expect(tx).toBeNull()
    })

    it('should return null on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const tx = await provider.getTransaction('abc123')
      expect(tx).toBeNull()
    })
  })

  describe('getBlock', () => {
    it('should return relay info as pseudo-block', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          name: 'Test Relay',
          supported_nips: [1, 11],
        }),
      )

      const block = await provider.getBlock(0)
      expect(block).not.toBeNull()
      expect(block!.number).toBe(0)
      expect(block!.transactions).toEqual([])
    })

    it('should return null on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Failed'))

      const block = await provider.getBlock(0)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return zero fees', async () => {
      const fee = await provider.estimateFee()
      expect(fee.slow).toBe('0')
      expect(fee.average).toBe('0')
      expect(fee.fast).toBe('0')
      expect(fee.unit).toBe('sat')
    })
  })

  describe('broadcastTransaction', () => {
    it('should publish event and return event ID', async () => {
      const signedEvent = JSON.stringify({
        id: 'eventid'.padEnd(64, '0'),
        pubkey: 'pubkey'.padEnd(64, '0'),
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: 'hello',
        sig: 'sig'.padEnd(128, '0'),
      })

      mockFetch.mockResolvedValueOnce(
        mockRpcResponse(['OK', 'eventid'.padEnd(64, '0'), true, '']),
      )

      const txHash = await provider.broadcastTransaction(signedEvent)
      expect(txHash).toBe('eventid'.padEnd(64, '0'))
    })

    it('should throw on invalid JSON', async () => {
      await expect(
        provider.broadcastTransaction('not-json'),
      ).rejects.toThrow('signedTx must be a JSON-encoded Nostr event')
    })
  })

  describe('getChainInfo', () => {
    it('should return Nostr chain info from relay', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          name: 'My Relay',
          supported_nips: [1, 11, 50],
        }),
      )

      const info = await provider.getChainInfo()
      expect(info.chainId).toBe('nostr')
      expect(info.name).toBe('My Relay')
      expect(info.symbol).toBe('SAT')
      expect(info.decimals).toBe(0)
      expect(info.testnet).toBe(false)
    })

    it('should return default info on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Failed'))

      const info = await provider.getChainInfo()
      expect(info.chainId).toBe('nostr')
      expect(info.name).toBe('Nostr Relay')
    })
  })

  describe('subscribeBlocks', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse(null))

      const unsubscribe = await provider.subscribeBlocks(() => {})
      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse([]))

      const unsubscribe = await provider.subscribeTransactions(
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        () => {},
      )
      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })
})
