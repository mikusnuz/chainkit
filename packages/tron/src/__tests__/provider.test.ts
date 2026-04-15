import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TronProvider } from '../provider.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  }
}

function mockError(status: number, statusText: string) {
  return {
    ok: false,
    status,
    statusText,
  }
}

describe('TronProvider', () => {
  let provider: TronProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new TronProvider({
      endpoint: 'https://api.trongrid.io',
    })
  })

  describe('constructor', () => {
    it('should throw if no endpoint provided', () => {
      expect(() => new TronProvider({ endpoint: '' })).toThrow('Tron endpoint URL is required')
    })

    it('should strip trailing slashes from endpoint', () => {
      const p = new TronProvider({ endpoint: 'https://api.trongrid.io/' })
      // Verify by calling a method that uses the endpoint
      mockFetch.mockResolvedValueOnce(mockResponse({ balance: 0 }))
      p.getBalance('TJRabPrwbZy45sbavfcjinPJC18kjpRTv8')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.trongrid.io/wallet/getaccount',
        expect.any(Object),
      )
    })
  })

  describe('getBalance', () => {
    it('should return TRX balance for an address', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        balance: 5000000,
        address: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c',
      }))

      const balance = await provider.getBalance('TJRabPrwbZy45sbavfcjinPJC18kjpRTv8')

      expect(balance).toEqual({
        address: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
        amount: '5000000',
        symbol: 'TRX',
        decimals: 6,
      })
    })

    it('should return 0 balance for a non-existent account', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}))

      const balance = await provider.getBalance('TJRabPrwbZy45sbavfcjinPJC18kjpRTv8')
      expect(balance.amount).toBe('0')
    })

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(mockError(500, 'Internal Server Error'))

      await expect(provider.getBalance('TJRabPrwbZy45sbavfcjinPJC18kjpRTv8')).rejects.toThrow(
        'HTTP 500',
      )
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info', async () => {
      // First call: gettransactionbyid
      mockFetch.mockResolvedValueOnce(mockResponse({
        txID: 'abc123def456',
        raw_data: {
          contract: [{
            parameter: {
              value: {
                owner_address: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c',
                to_address: '41b614f803b6fd780986a42c78ec9c7f77e6ded13c',
                amount: 1000000,
              },
            },
          }],
        },
        ret: [{ contractRet: 'SUCCESS' }],
      }))

      // Second call: gettransactioninfobyid
      mockFetch.mockResolvedValueOnce(mockResponse({
        fee: 100000,
        blockNumber: 12345,
        blockHash: 'blockhash123',
        blockTimeStamp: 1700000000000,
      }))

      const tx = await provider.getTransaction('abc123def456')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('abc123def456')
      expect(tx!.value).toBe('1000000')
      expect(tx!.fee).toBe('100000')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(12345)
      expect(tx!.timestamp).toBe(1700000000)
    })

    it('should return null for non-existent transaction', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}))

      const tx = await provider.getTransaction('nonexistent')
      expect(tx).toBeNull()
    })

    it('should detect failed transactions', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        txID: 'failed123',
        raw_data: {
          contract: [{
            parameter: {
              value: {
                owner_address: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c',
                to_address: '41b614f803b6fd780986a42c78ec9c7f77e6ded13c',
                amount: 1000000,
              },
            },
          }],
        },
        ret: [{ contractRet: 'REVERT' }],
      }))

      mockFetch.mockResolvedValueOnce(mockResponse({
        fee: 50000,
        blockNumber: 12346,
      }))

      const tx = await provider.getTransaction('failed123')
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should return block info by number', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        blockID: 'block123hash',
        block_header: {
          raw_data: {
            number: 100,
            timestamp: 1700000000000,
            parentHash: 'parent123',
          },
        },
        transactions: [
          { txID: 'tx1' },
          { txID: 'tx2' },
        ],
      }))

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('block123hash')
      expect(block!.parentHash).toBe('parent123')
      expect(block!.timestamp).toBe(1700000000)
      expect(block!.transactions).toEqual(['tx1', 'tx2'])
    })

    it('should return null for non-existent block', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}))

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })

    it('should handle block by hash string', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        blockID: 'someblockhash',
        block_header: {
          raw_data: {
            number: 50,
            timestamp: 1700000000000,
            parentHash: 'parent50',
          },
        },
      }))

      const block = await provider.getBlock('someblockhash')
      expect(block!.number).toBe(50)

      // Should have called getblockbyid for string input
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.trongrid.io/wallet/getblockbyid',
        expect.any(Object),
      )
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates in SUN', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        chainParameter: [
          { key: 'getTransactionFee', value: 1000 },
          { key: 'getEnergyFee', value: 420 },
        ],
      }))

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('SUN')
      // 270 bandwidth * 1000 SUN = 270000
      expect(fee.slow).toBe('270000')
      expect(fee.average).toBe('270000')
      expect(fee.fast).toBe('270000')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a signed transaction and return txid', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: true,
        txid: 'broadcast123',
      }))

      const txId = await provider.broadcastTransaction(
        JSON.stringify({ txID: 'broadcast123', raw_data: {}, signature: ['abc'] }),
      )

      expect(txId).toBe('broadcast123')
    })

    it('should throw on broadcast failure', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: false,
        message: 'SIGERROR',
      }))

      await expect(
        provider.broadcastTransaction(JSON.stringify({ txID: 'fail', raw_data: {} })),
      ).rejects.toThrow()
    })

    it('should throw for non-JSON input', async () => {
      await expect(
        provider.broadcastTransaction('not-json'),
      ).rejects.toThrow('JSON-encoded signed transaction')
    })
  })

  describe('getChainInfo', () => {
    it('should return chain info for mainnet', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        block_header: {
          raw_data: {
            number: 50000,
            timestamp: 1700000000000,
          },
        },
      }))

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('tron-mainnet')
      expect(info.name).toBe('Tron Mainnet')
      expect(info.symbol).toBe('TRX')
      expect(info.decimals).toBe(6)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(50000)
    })

    it('should detect Shasta testnet from endpoint', async () => {
      const shastaProvider = new TronProvider({
        endpoint: 'https://api.shasta.trongrid.io',
      })

      mockFetch.mockResolvedValueOnce(mockResponse({
        block_header: {
          raw_data: { number: 100 },
        },
      }))

      const info = await shastaProvider.getChainInfo()
      expect(info.chainId).toBe('tron-shasta')
      expect(info.testnet).toBe(true)
    })

    it('should detect Nile testnet from endpoint', async () => {
      const nileProvider = new TronProvider({
        endpoint: 'https://nile.trongrid.io',
      })

      mockFetch.mockResolvedValueOnce(mockResponse({
        block_header: {
          raw_data: { number: 200 },
        },
      }))

      const info = await nileProvider.getChainInfo()
      expect(info.chainId).toBe('tron-nile')
      expect(info.testnet).toBe(true)
    })
  })

  describe('callContract', () => {
    it('should call a contract method and return result', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        constant_result: ['0000000000000000000000000000000000000000000000000000000005f5e100'],
      }))

      const result = await provider.callContract(
        'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
        'balanceOf(address)',
        ['TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'],
      )

      expect(result).toBe('0x0000000000000000000000000000000000000000000000000000000005f5e100')
    })

    it('should return null when no result', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}))

      const result = await provider.callContract(
        'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
        'someMethod()',
      )

      expect(result).toBeNull()
    })
  })

  describe('estimateGas', () => {
    it('should return energy estimate', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        energy_used: 30000,
        constant_result: ['0000000000000000000000000000000000000000000000000000000000000001'],
      }))

      const gas = await provider.estimateGas(
        'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
        'transfer(address,uint256)',
        ['TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', 1000000n],
      )

      expect(gas).toBe('30000')
    })

    it('should return 0 when no energy used', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}))

      const gas = await provider.estimateGas(
        'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
        'name()',
      )

      expect(gas).toBe('0')
    })
  })

  describe('getTokenBalance', () => {
    it('should return TRC-20 token balance', async () => {
      // balanceOf response
      mockFetch.mockResolvedValueOnce(mockResponse({
        constant_result: ['0000000000000000000000000000000000000000000000000000000005f5e100'],
      }))
      // decimals response
      mockFetch.mockResolvedValueOnce(mockResponse({
        constant_result: ['0000000000000000000000000000000000000000000000000000000000000006'],
      }))
      // symbol response
      mockFetch.mockResolvedValueOnce(mockResponse({
        constant_result: [
          '0000000000000000000000000000000000000000000000000000000000000020' +
          '0000000000000000000000000000000000000000000000000000000000000004' +
          '5553445400000000000000000000000000000000000000000000000000000000',
        ],
      }))

      const balance = await provider.getTokenBalance(
        'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
        'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT on Tron
      )

      expect(balance.amount).toBe('100000000') // 0x5f5e100 = 100000000
      expect(balance.decimals).toBe(6)
      expect(balance.symbol).toBe('USDT')
    })
  })

  describe('getTokenMetadata', () => {
    it('should return TRC-20 token metadata', async () => {
      // name response
      mockFetch.mockResolvedValueOnce(mockResponse({
        constant_result: [
          '0000000000000000000000000000000000000000000000000000000000000020' +
          '000000000000000000000000000000000000000000000000000000000000000a' +
          '546574686572205553440000000000000000000000000000000000000000000000',
        ],
      }))
      // symbol response
      mockFetch.mockResolvedValueOnce(mockResponse({
        constant_result: [
          '0000000000000000000000000000000000000000000000000000000000000020' +
          '0000000000000000000000000000000000000000000000000000000000000004' +
          '5553445400000000000000000000000000000000000000000000000000000000',
        ],
      }))
      // decimals response
      mockFetch.mockResolvedValueOnce(mockResponse({
        constant_result: ['0000000000000000000000000000000000000000000000000000000000000006'],
      }))
      // totalSupply response
      mockFetch.mockResolvedValueOnce(mockResponse({
        constant_result: ['00000000000000000000000000000000000000000000000000005af3107a4000'],
      }))

      const metadata = await provider.getTokenMetadata('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')

      expect(metadata.name).toBe('Tether USD')
      expect(metadata.symbol).toBe('USDT')
      expect(metadata.decimals).toBe(6)
      expect(metadata.address).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
      expect(BigInt(metadata.totalSupply!)).toBeGreaterThan(0n)
    })
  })

  describe('subscribeBlocks', () => {
    it('should call callback when new block appears', async () => {
      const callback = vi.fn()

      // First poll
      mockFetch.mockResolvedValueOnce(mockResponse({
        block_header: {
          raw_data: { number: 100 },
        },
      }))

      const unsub = await provider.subscribeBlocks(callback)

      // Wait for the first poll
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(callback).toHaveBeenCalledWith(100)

      // Cleanup
      unsub()
    })
  })

  describe('subscribeTransactions', () => {
    it('should initialize and return an unsubscribe function', async () => {
      // getnowblock for initialization
      mockFetch.mockResolvedValueOnce(mockResponse({
        block_header: {
          raw_data: { number: 500 },
        },
      }))

      const callback = vi.fn()
      const unsub = await provider.subscribeTransactions(
        'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
        callback,
      )

      expect(typeof unsub).toBe('function')
      unsub()
    })
  })

  describe('API key support', () => {
    it('should include API key in headers when provided', async () => {
      const providerWithKey = new TronProvider({
        endpoint: 'https://api.trongrid.io',
        apiKey: 'test-api-key-123',
      })

      mockFetch.mockResolvedValueOnce(mockResponse({ balance: 0 }))

      await providerWithKey.getBalance('TJRabPrwbZy45sbavfcjinPJC18kjpRTv8')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'TRON-PRO-API-KEY': 'test-api-key-123',
          }),
        }),
      )
    })
  })

  describe('error handling', () => {
    it('should throw on Tron API error response', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        Error: 'Account not found',
      }))

      // Use hex address to avoid base58 decode error
      await expect(
        provider.getBalance('41a614f803b6fd780986a42c78ec9c7f77e6ded13c'),
      ).rejects.toThrow('Account not found')
    })
  })
})
