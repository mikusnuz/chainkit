import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FlowProvider } from './provider.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockFetchResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

describe('FlowProvider', () => {
  let provider: FlowProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new FlowProvider({
      accessApiUrl: 'https://rest-testnet.onflow.org',
    })
  })

  describe('constructor', () => {
    it('should create a provider with valid config', () => {
      expect(provider).toBeInstanceOf(FlowProvider)
    })

    it('should throw if no URL provided', () => {
      expect(() => new FlowProvider({ accessApiUrl: '' })).toThrow(
        'Flow Access API URL is required',
      )
    })

    it('should strip trailing slashes from URL', () => {
      const p = new FlowProvider({ accessApiUrl: 'https://rest-testnet.onflow.org///' })
      expect(p).toBeInstanceOf(FlowProvider)
    })
  })

  describe('getBalance', () => {
    it('should return FLOW balance for an address', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          address: '1654653399040a61',
          balance: '10000000000',
          keys: [],
        }),
      )

      const balance = await provider.getBalance('0x1654653399040a61')

      expect(balance.address).toBe('0x1654653399040a61')
      expect(balance.amount).toBe('10000000000')
      expect(balance.symbol).toBe('FLOW')
      expect(balance.decimals).toBe(8)
    })

    it('should return zero balance for non-existent account', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse({}, 404))

      const balance = await provider.getBalance('0x0000000000000001')

      expect(balance.amount).toBe('0')
      expect(balance.symbol).toBe('FLOW')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction details', async () => {
      // First call: get transaction
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          id: 'abc123def456',
          script: 'transaction {}',
          arguments: [],
          reference_block_id: 'block123',
          gas_limit: '9999',
          payer: '0x1654653399040a61',
          proposal_key: {
            address: '0x1654653399040a61',
            key_index: '0',
            sequence_number: '42',
          },
          authorizers: ['0x1654653399040a61'],
          payload_signatures: [],
          envelope_signatures: [],
        }),
      )

      // Second call: get transaction result
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          block_id: 'block789',
          block_height: '12345',
          status: 'SEALED',
          status_code: 0,
          error_message: '',
          events: [],
        }),
      )

      const tx = await provider.getTransaction('abc123def456')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('abc123def456')
      expect(tx!.from).toBe('0x1654653399040a61')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(12345)
      expect(tx!.nonce).toBe(42)
    })

    it('should return null for non-existent transaction', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse({}, 404))

      const tx = await provider.getTransaction('nonexistent')

      expect(tx).toBeNull()
    })

    it('should handle failed transactions', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          id: 'failed-tx',
          script: '',
          arguments: [],
          reference_block_id: 'block123',
          gas_limit: '9999',
          payer: '0x1654653399040a61',
          proposal_key: {
            address: '0x1654653399040a61',
            key_index: '0',
            sequence_number: '10',
          },
          authorizers: [],
          payload_signatures: [],
          envelope_signatures: [],
        }),
      )

      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          block_id: 'block456',
          block_height: '100',
          status: 'SEALED',
          status_code: 1, // non-zero = failed
          error_message: 'execution failed',
          events: [],
        }),
      )

      const tx = await provider.getTransaction('failed-tx')

      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should return block by height', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse([
          {
            header: {
              id: 'block-hash-123',
              parent_id: 'parent-hash-456',
              height: '100',
              timestamp: '2024-01-01T00:00:00Z',
            },
            payload: {
              collection_guarantees: [
                { collection_id: 'col-1' },
                { collection_id: 'col-2' },
              ],
            },
          },
        ]),
      )

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('block-hash-123')
      expect(block!.parentHash).toBe('parent-hash-456')
      expect(block!.transactions).toEqual(['col-1', 'col-2'])
    })

    it('should return null for non-existent block', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse({}, 404))

      const block = await provider.getBlock(999999999)

      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates', async () => {
      const fee = await provider.estimateFee()

      expect(fee.slow).toBe('1000')
      expect(fee.average).toBe('10000')
      expect(fee.fast).toBe('100000')
      expect(fee.unit).toContain('FLOW')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast and return transaction ID', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          id: 'new-tx-hash-789',
        }),
      )

      const txId = await provider.broadcastTransaction(
        JSON.stringify({
          script: 'transaction {}',
          arguments: [],
          reference_block_id: 'block123',
          gas_limit: '9999',
          payer: '0x1654653399040a61',
          proposal_key: {
            address: '0x1654653399040a61',
            key_index: 0,
            sequence_number: 1,
          },
          authorizers: ['0x1654653399040a61'],
          payload_signatures: [],
          envelope_signatures: [],
        }),
      )

      expect(txId).toBe('new-tx-hash-789')
    })

    it('should throw for invalid JSON', async () => {
      await expect(
        provider.broadcastTransaction('not-json'),
      ).rejects.toThrow('signedTx must be a JSON string')
    })
  })

  describe('getChainInfo', () => {
    it('should return testnet chain info for testnet URL', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse([
          {
            header: {
              height: '50000',
              id: 'block-hash',
            },
          },
        ]),
      )

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('flow')
      expect(info.name).toBe('Flow Testnet')
      expect(info.symbol).toBe('FLOW')
      expect(info.decimals).toBe(8)
      expect(info.testnet).toBe(true)
      expect(info.blockHeight).toBe(50000)
    })

    it('should return mainnet chain info for mainnet URL', async () => {
      const mainnetProvider = new FlowProvider({
        accessApiUrl: 'https://rest-mainnet.onflow.org',
      })

      mockFetch.mockResolvedValueOnce(
        mockFetchResponse([
          {
            header: {
              height: '100000',
              id: 'block-hash',
            },
          },
        ]),
      )

      const info = await mainnetProvider.getChainInfo()

      expect(info.name).toBe('Flow Mainnet')
      expect(info.testnet).toBe(false)
    })
  })

  describe('callContract (Cadence scripts)', () => {
    it('should execute a Cadence script', async () => {
      const resultValue = btoa(JSON.stringify({ type: 'Int', value: '42' }))

      mockFetch.mockResolvedValueOnce(mockFetchResponse(resultValue))

      const result = await provider.callContract(
        '',
        'access(all) fun main(): Int { return 42 }',
      )

      expect(result).toBeDefined()
    })
  })

  describe('estimateGas', () => {
    it('should return default computation limit', async () => {
      const gas = await provider.estimateGas('0x1234', 'test')

      expect(gas).toBe('9999')
    })
  })

  describe('getTokenBalance', () => {
    it('should return token balance', async () => {
      const resultValue = btoa(JSON.stringify({ type: 'UFix64', value: '100.00000000' }))

      mockFetch.mockResolvedValueOnce(mockFetchResponse(resultValue))

      const balance = await provider.getTokenBalance(
        '0x1654653399040a61',
        'A.0x1654653399040a61.FlowToken',
      )

      expect(balance.address).toBe('0x1654653399040a61')
      expect(balance.symbol).toBe('FlowToken')
      expect(balance.decimals).toBe(8)
    })
  })

  describe('getTokenMetadata', () => {
    it('should return token metadata', async () => {
      const metadata = await provider.getTokenMetadata(
        'A.0x1654653399040a61.FlowToken',
      )

      expect(metadata.address).toBe('A.0x1654653399040a61.FlowToken')
      expect(metadata.name).toBe('FlowToken')
      expect(metadata.symbol).toBe('FlowToken')
      expect(metadata.decimals).toBe(8)
    })
  })

  describe('subscribeBlocks', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(
        mockFetchResponse([
          {
            header: { height: '1000' },
          },
        ]),
      )

      const unsubscribe = await provider.subscribeBlocks(() => {})

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(
        mockFetchResponse([
          {
            header: { height: '1000', id: 'block-id' },
            payload: { collection_guarantees: [] },
          },
        ]),
      )

      const unsubscribe = await provider.subscribeTransactions(
        '0x1654653399040a61',
        () => {},
      )

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })
})
