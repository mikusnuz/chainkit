import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TonProvider } from '../provider.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockTonResponse<T>(result: T) {
  return {
    ok: true,
    json: async () => ({ ok: true, result }),
  }
}

function mockTonError(error: string) {
  return {
    ok: true,
    json: async () => ({ ok: false, error }),
  }
}

describe('TonProvider', () => {
  let provider: TonProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new TonProvider({
      endpoint: 'https://toncenter.com/api/v2',
    })
  })

  describe('constructor', () => {
    it('should create a provider with valid config', () => {
      const p = new TonProvider({ endpoint: 'https://toncenter.com/api/v2' })
      expect(p).toBeInstanceOf(TonProvider)
    })

    it('should throw if endpoint is empty', () => {
      expect(() => new TonProvider({ endpoint: '' })).toThrow('TON API endpoint is required')
    })

    it('should accept an API key', () => {
      const p = new TonProvider({
        endpoint: 'https://toncenter.com/api/v2',
        apiKey: 'test-key',
      })
      expect(p).toBeInstanceOf(TonProvider)
    })
  })

  describe('getBalance', () => {
    it('should return balance for an address', async () => {
      mockFetch.mockResolvedValueOnce(mockTonResponse('1500000000'))

      const balance = await provider.getBalance('0:abc123')

      expect(balance).toEqual({
        address: '0:abc123',
        amount: '1500000000',
        symbol: 'TON',
        decimals: 9,
      })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const url = new URL(mockFetch.mock.calls[0][0])
      expect(url.pathname).toBe('/api/v2/getAddressBalance')
      expect(url.searchParams.get('address')).toBe('0:abc123')
    })

    it('should return zero balance', async () => {
      mockFetch.mockResolvedValueOnce(mockTonResponse('0'))

      const balance = await provider.getBalance('0:000')

      expect(balance.amount).toBe('0')
      expect(balance.decimals).toBe(9)
      expect(balance.symbol).toBe('TON')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info in address:lt:hash format', async () => {
      const mockTx = {
        transaction_id: { lt: '12345', hash: 'txhash123' },
        fee: '5000000',
        utime: 1700000000,
        in_msg: {
          source: '0:sender',
          destination: '0:receiver',
          value: '1000000000',
        },
        out_msgs: [],
      }

      mockFetch.mockResolvedValueOnce(mockTonResponse([mockTx]))

      const tx = await provider.getTransaction('0:receiver:12345:txhash123')

      expect(tx).not.toBeNull()
      expect(tx!.from).toBe('0:sender')
      expect(tx!.to).toBe('0:receiver')
      expect(tx!.value).toBe('1000000000')
      expect(tx!.fee).toBe('5000000')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.timestamp).toBe(1700000000)
    })

    it('should throw for invalid hash format', async () => {
      await expect(provider.getTransaction('invalid-hash')).rejects.toThrow(
        'TON transaction lookup requires format "address:lt:hash"',
      )
    })

    it('should return null when no transactions found', async () => {
      mockFetch.mockResolvedValueOnce(mockTonResponse([]))

      const tx = await provider.getTransaction('0:addr:12345:hash')
      expect(tx).toBeNull()
    })
  })

  describe('getBlock', () => {
    it('should return block info by seqno', async () => {
      const mockBlock = {
        id: {
          workchain: -1,
          shard: '-9223372036854775808',
          seqno: 100,
          root_hash: 'root_hash_123',
          file_hash: 'file_hash_123',
        },
        gen_utime: 1700000000,
        prev_blocks: [
          {
            workchain: -1,
            shard: '-9223372036854775808',
            seqno: 99,
            root_hash: 'prev_root_hash',
            file_hash: 'prev_file_hash',
          },
        ],
      }

      mockFetch.mockResolvedValueOnce(mockTonResponse(mockBlock))

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('root_hash_123')
      expect(block!.parentHash).toBe('prev_root_hash')
      expect(block!.timestamp).toBe(1700000000)
    })

    it('should accept string seqno', async () => {
      const mockBlock = {
        id: { root_hash: 'hash123' },
        gen_utime: 1700000000,
        prev_blocks: [],
      }

      mockFetch.mockResolvedValueOnce(mockTonResponse(mockBlock))

      const block = await provider.getBlock('50')

      expect(block).not.toBeNull()
      expect(block!.number).toBe(50)
    })

    it('should throw for non-numeric string', async () => {
      await expect(provider.getBlock('invalid')).rejects.toThrow(
        'TON block lookup requires a sequence number',
      )
    })

    it('should return null when block not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'block not found' }),
      })

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates in nanoton', async () => {
      const fee = await provider.estimateFee()

      expect(fee.slow).toBe('5000000')
      expect(fee.average).toBe('10000000')
      expect(fee.fast).toBe('50000000')
      expect(fee.unit).toBe('nanoton')
    })
  })

  describe('estimateTransactionFee', () => {
    it('should return detailed fee breakdown', async () => {
      mockFetch.mockResolvedValueOnce(
        mockTonResponse({
          source_fees: {
            in_fwd_fee: 1000,
            storage_fee: 2000,
            gas_fee: 3000,
            fwd_fee: 4000,
          },
        }),
      )

      const fee = await provider.estimateTransactionFee('0:addr', 'body-boc')

      expect(fee.gasFee).toBe('3000')
      expect(fee.storageFee).toBe('2000')
      expect(fee.forwardFee).toBe('5000') // fwd_fee + in_fwd_fee
      expect(fee.totalFee).toBe('10000')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a signed BOC', async () => {
      mockFetch.mockResolvedValueOnce(
        mockTonResponse({ hash: 'tx_hash_result' }),
      )

      const hash = await provider.broadcastTransaction('0xdeadbeef')

      expect(hash).toBe('tx_hash_result')
      expect(mockFetch).toHaveBeenCalledTimes(1)

      const [url, options] = mockFetch.mock.calls[0]
      expect(new URL(url).pathname).toBe('/api/v2/sendBoc')
      expect(options.method).toBe('POST')

      const body = JSON.parse(options.body)
      expect(body.boc).toBe('deadbeef')
    })
  })

  describe('getChainInfo', () => {
    it('should return TON chain info', async () => {
      mockFetch.mockResolvedValueOnce(
        mockTonResponse({
          last: {
            workchain: -1,
            shard: '-9223372036854775808',
            seqno: 42000000,
            root_hash: 'hash123',
            file_hash: 'file123',
          },
        }),
      )

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('-1')
      expect(info.name).toBe('TON')
      expect(info.symbol).toBe('TON')
      expect(info.decimals).toBe(9)
      expect(info.blockHeight).toBe(42000000)
    })

    it('should detect testnet from endpoint URL', async () => {
      const testnetProvider = new TonProvider({
        endpoint: 'https://testnet.toncenter.com/api/v2',
      })

      mockFetch.mockResolvedValueOnce(
        mockTonResponse({
          last: { seqno: 100 },
        }),
      )

      const info = await testnetProvider.getChainInfo()
      expect(info.testnet).toBe(true)
    })
  })

  describe('callContract', () => {
    it('should call a GET method on a contract', async () => {
      mockFetch.mockResolvedValueOnce(
        mockTonResponse({
          gas_used: 500,
          exit_code: 0,
          stack: [['num', '0x64']],
        }),
      )

      const result = await provider.callContract('0:contract', 'seqno')

      expect(result).toEqual({
        gas_used: 500,
        exit_code: 0,
        stack: [['num', '0x64']],
      })

      const [url, options] = mockFetch.mock.calls[0]
      expect(new URL(url).pathname).toBe('/api/v2/runGetMethod')
      expect(options.method).toBe('POST')

      const body = JSON.parse(options.body)
      expect(body.address).toBe('0:contract')
      expect(body.method).toBe('seqno')
    })

    it('should pass numeric parameters as hex', async () => {
      mockFetch.mockResolvedValueOnce(
        mockTonResponse({
          exit_code: 0,
          stack: [],
        }),
      )

      await provider.callContract('0:contract', 'get_data', [42])

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.stack).toEqual([['num', '0x2a']])
    })
  })

  describe('estimateGas', () => {
    it('should return gas_used from runGetMethod', async () => {
      mockFetch.mockResolvedValueOnce(
        mockTonResponse({
          gas_used: 1234,
          exit_code: 0,
          stack: [],
        }),
      )

      const gas = await provider.estimateGas('0:contract', 'seqno')
      expect(gas).toBe('1234')
    })
  })

  describe('getTokenBalance', () => {
    it('should query Jetton wallet balance', async () => {
      // First call: get_wallet_address on Jetton master
      mockFetch.mockResolvedValueOnce(
        mockTonResponse({
          exit_code: 0,
          stack: [['tvm.Slice', '0:jetton_wallet_address']],
        }),
      )

      // Second call: get_wallet_data on Jetton wallet
      mockFetch.mockResolvedValueOnce(
        mockTonResponse({
          exit_code: 0,
          stack: [['num', '0x3b9aca00']], // 1000000000 = 1 token
        }),
      )

      const balance = await provider.getTokenBalance('0:user', '0:jetton_master')

      expect(balance.address).toBe('0:user')
      expect(balance.amount).toBe('1000000000')
      expect(balance.decimals).toBe(9)
    })

    it('should return zero balance on error', async () => {
      mockFetch.mockResolvedValueOnce(
        mockTonResponse({
          exit_code: -1,
          stack: [],
        }),
      )

      const balance = await provider.getTokenBalance('0:user', '0:jetton_master')
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTokenMetadata', () => {
    it('should return Jetton metadata', async () => {
      mockFetch.mockResolvedValueOnce(
        mockTonResponse({
          exit_code: 0,
          stack: [
            ['num', '0xe8d4a51000'], // total supply
            ['num', '0x1'],          // mintable
            ['tvm.Slice', '0:admin'], // admin address
          ],
        }),
      )

      const metadata = await provider.getTokenMetadata('0:jetton')

      expect(metadata.address).toBe('0:jetton')
      expect(metadata.totalSupply).toBe('1000000000000')
      expect(metadata.decimals).toBe(9)
    })

    it('should throw when get_jetton_data fails', async () => {
      mockFetch.mockResolvedValueOnce(
        mockTonResponse({
          exit_code: -1,
          stack: [],
        }),
      )

      await expect(provider.getTokenMetadata('0:bad_jetton')).rejects.toThrow(
        'Failed to get Jetton data',
      )
    })
  })

  describe('subscribeBlocks', () => {
    it('should call callback on new blocks', async () => {
      // Use a dedicated provider for subscription tests to avoid mock leaking
      const subProvider = new TonProvider({
        endpoint: 'https://toncenter.com/api/v2',
      })

      // Return incrementing seqno
      mockFetch
        .mockResolvedValueOnce(mockTonResponse({ last: { seqno: 100 } }))
        .mockResolvedValueOnce(mockTonResponse({ last: { seqno: 101 } }))

      const blocks: number[] = []
      const unsub = await subProvider.subscribeBlocks((blockNumber) => {
        blocks.push(blockNumber)
      })

      // Wait for first poll
      await new Promise((resolve) => setTimeout(resolve, 100))

      unsub()

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(blocks.length).toBeGreaterThanOrEqual(1)
      expect(blocks[0]).toBe(100)

      // Reset mocks to clear any pending implementations
      mockFetch.mockReset()
    })
  })

  describe('subscribeTransactions', () => {
    it('should initialize and return unsubscribe function', async () => {
      const subProvider = new TonProvider({
        endpoint: 'https://toncenter.com/api/v2',
      })

      // Initial fetch for lastLt
      mockFetch.mockResolvedValueOnce(
        mockTonResponse([
          {
            transaction_id: { lt: '100', hash: 'hash1' },
            fee: '1000',
            utime: 1700000000,
            in_msg: { source: '0:sender', destination: '0:addr', value: '500' },
            out_msgs: [],
          },
        ]),
      )

      const unsub = await subProvider.subscribeTransactions('0:addr', () => {})

      expect(typeof unsub).toBe('function')
      unsub()

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Reset mocks to clear any pending implementations
      mockFetch.mockReset()
    })
  })

  describe('error handling', () => {
    it('should handle TON API errors', async () => {
      mockFetch.mockReset()
      mockFetch.mockResolvedValueOnce(mockTonError('address not found'))

      await expect(provider.getBalance('0:bad')).rejects.toThrow('address not found')
    })

    it('should handle HTTP errors', async () => {
      mockFetch.mockReset()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })

      await expect(provider.getBalance('0:addr')).rejects.toThrow('HTTP 500')
    })

    it('should handle network errors', async () => {
      mockFetch.mockReset()
      mockFetch.mockRejectedValueOnce(new Error('fetch failed'))

      await expect(provider.getBalance('0:addr')).rejects.toThrow('Request failed')
    })

    it('should include API key in requests when configured', async () => {
      mockFetch.mockReset()
      const providerWithKey = new TonProvider({
        endpoint: 'https://toncenter.com/api/v2',
        apiKey: 'my-api-key',
      })

      mockFetch.mockResolvedValueOnce(mockTonResponse('0'))

      await providerWithKey.getBalance('0:addr')

      const lastCallUrl = new URL(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0])
      expect(lastCallUrl.searchParams.get('api_key')).toBe('my-api-key')
    })
  })
})
