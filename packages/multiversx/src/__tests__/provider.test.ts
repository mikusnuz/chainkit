import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MultiversXProvider } from '../provider.js'

const API_URL = 'https://testnet-api.multiversx.com'

function mockFetchResponse(data: unknown, ok = true, status = 200): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response)
}

describe('MultiversXProvider', () => {
  let provider: MultiversXProvider

  beforeEach(() => {
    provider = new MultiversXProvider({ apiUrl: API_URL })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getBalance', () => {
    it('should return balance for an address', async () => {
      mockFetchResponse({ balance: '1000000000000000000' })

      const balance = await provider.getBalance(
        'erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6gq4hu',
      )

      expect(balance.address).toBe(
        'erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6gq4hu',
      )
      expect(balance.amount).toBe('1000000000000000000')
      expect(balance.symbol).toBe('EGLD')
      expect(balance.decimals).toBe(18)
    })

    it('should call the correct API endpoint', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ balance: '0' }),
      } as unknown as Response)

      const addr = 'erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6gq4hu'
      await provider.getBalance(addr)

      expect(fetchSpy).toHaveBeenCalledWith(
        `${API_URL}/accounts/${addr}`,
        expect.objectContaining({ method: 'GET' }),
      )
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info for a valid hash', async () => {
      mockFetchResponse({
        txHash: 'abc123',
        sender: 'erd1sender',
        receiver: 'erd1receiver',
        value: '1000000000000000000',
        fee: '50000000000000',
        status: 'success',
        timestamp: 1700000000,
        nonce: 5,
        blockNonce: 100,
        blockHash: 'blockhash123',
      })

      const tx = await provider.getTransaction('abc123')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('abc123')
      expect(tx!.from).toBe('erd1sender')
      expect(tx!.to).toBe('erd1receiver')
      expect(tx!.value).toBe('1000000000000000000')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(100)
      expect(tx!.nonce).toBe(5)
    })

    it('should return null for a non-existent transaction', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.reject(new Error('404')),
        text: () => Promise.resolve('404 Not Found'),
      } as unknown as Response)

      const tx = await provider.getTransaction('nonexistent')
      expect(tx).toBeNull()
    })

    it('should handle failed transactions', async () => {
      mockFetchResponse({
        txHash: 'failed123',
        sender: 'erd1sender',
        receiver: 'erd1receiver',
        value: '0',
        fee: '50000000000000',
        status: 'fail',
        timestamp: 1700000000,
        nonce: 3,
      })

      const tx = await provider.getTransaction('failed123')
      expect(tx).not.toBeNull()
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should return block info by nonce', async () => {
      mockFetchResponse({
        nonce: 100,
        hash: 'blockhash100',
        prevHash: 'blockhash99',
        timestamp: 1700000000,
        numTxs: 2,
        miniBlocks: [
          { hash: 'mb1', txHashes: ['tx1', 'tx2'] },
        ],
      })

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('blockhash100')
      expect(block!.parentHash).toBe('blockhash99')
      expect(block!.transactions).toEqual(['tx1', 'tx2'])
    })

    it('should return block info by hash string', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () =>
          Promise.resolve({
            nonce: 50,
            hash: 'abcdef123456',
            prevHash: 'prevhash',
            timestamp: 1700000000,
            numTxs: 0,
          }),
      } as unknown as Response)

      const block = await provider.getBlock('abcdef123456')

      expect(block).not.toBeNull()
      expect(block!.hash).toBe('abcdef123456')
      expect(fetchSpy).toHaveBeenCalledWith(
        `${API_URL}/blocks/abcdef123456?withTxs=true`,
        expect.anything(),
      )
    })

    it('should handle blocks with no miniblocks', async () => {
      mockFetchResponse({
        nonce: 200,
        hash: 'blockhash200',
        prevHash: 'blockhash199',
        timestamp: 1700000000,
        numTxs: 0,
      })

      const block = await provider.getBlock(200)

      expect(block).not.toBeNull()
      expect(block!.transactions).toEqual([])
    })

    it('should return null for non-existent block', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.reject(new Error('404')),
        text: () => Promise.resolve('404 Not Found'),
      } as unknown as Response)

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates from network config', async () => {
      mockFetchResponse({
        config: {
          erd_min_gas_price: 1000000000,
          erd_min_gas_limit: 50000,
          erd_gas_per_data_byte: 1500,
        },
      })

      const fee = await provider.estimateFee()

      // 50000 * 1000000000 = 50000000000000
      expect(fee.slow).toBe('50000000000000')
      expect(fee.average).toBe('50000000000000')
      expect(fee.fast).toBe('50000000000000')
      expect(fee.unit).toBe('atto-EGLD')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a signed transaction and return tx hash', async () => {
      mockFetchResponse({ txHash: 'newtxhash123' })

      const txObj = JSON.stringify({
        nonce: 0,
        value: '1000000000000000000',
        receiver: 'erd1receiver',
        sender: 'erd1sender',
        gasPrice: 1000000000,
        gasLimit: 50000,
        chainID: '1',
        version: 1,
        signature: 'abcdef',
      })

      const txHash = await provider.broadcastTransaction(txObj)
      expect(txHash).toBe('newtxhash123')
    })

    it('should reject invalid JSON', async () => {
      await expect(provider.broadcastTransaction('not-json')).rejects.toThrow(
        'JSON-serialized',
      )
    })
  })

  describe('getChainInfo', () => {
    it('should return mainnet chain info', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({
              config: {
                erd_chain_id: '1',
                erd_denomination: 18,
              },
            }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({
              status: {
                erd_nonce: 12345,
                erd_current_round: 12350,
              },
            }),
        } as unknown as Response)

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('1')
      expect(info.name).toBe('MultiversX Mainnet')
      expect(info.symbol).toBe('EGLD')
      expect(info.decimals).toBe(18)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(12345)
    })

    it('should return testnet chain info', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({
              config: {
                erd_chain_id: 'T',
                erd_denomination: 18,
              },
            }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({
              status: {
                erd_nonce: 5000,
                erd_current_round: 5005,
              },
            }),
        } as unknown as Response)

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('T')
      expect(info.name).toBe('MultiversX Testnet')
      expect(info.testnet).toBe(true)
    })
  })

  describe('callContract', () => {
    it('should call a contract method via VM query', async () => {
      mockFetchResponse({
        data: {
          returnData: ['AQID'],
          returnCode: 'ok',
          returnMessage: '',
        },
      })

      const result = await provider.callContract(
        'erd1qqqqqqqqqqqqqpgqcontract',
        'getCounter',
        [],
      )

      expect(result).toEqual({
        returnData: ['AQID'],
        returnCode: 'ok',
        returnMessage: '',
      })
    })

    it('should throw on VM query failure', async () => {
      mockFetchResponse({
        data: {
          returnData: null,
          returnCode: 'user error',
          returnMessage: 'function not found',
        },
      })

      await expect(
        provider.callContract('erd1qqqqqqqqqqqqqpgqcontract', 'badFunction'),
      ).rejects.toThrow('VM query failed')
    })
  })

  describe('getTokenBalance', () => {
    it('should return ESDT token balance', async () => {
      mockFetchResponse({
        identifier: 'USDC-c76f1f',
        balance: '5000000',
        decimals: 6,
        ticker: 'USDC',
      })

      const balance = await provider.getTokenBalance(
        'erd1holder',
        'USDC-c76f1f',
      )

      expect(balance.amount).toBe('5000000')
      expect(balance.symbol).toBe('USDC')
      expect(balance.decimals).toBe(6)
    })

    it('should return zero balance for unknown token', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.reject(new Error('404')),
        text: () => Promise.resolve('404 Not Found'),
      } as unknown as Response)

      const balance = await provider.getTokenBalance(
        'erd1holder',
        'UNKNOWN-abcdef',
      )

      expect(balance.amount).toBe('0')
    })
  })

  describe('getTokenMetadata', () => {
    it('should return token metadata', async () => {
      mockFetchResponse({
        identifier: 'USDC-c76f1f',
        name: 'WrappedUSDC',
        ticker: 'USDC',
        decimals: 6,
        supply: '1000000000000',
      })

      const meta = await provider.getTokenMetadata('USDC-c76f1f')

      expect(meta.address).toBe('USDC-c76f1f')
      expect(meta.name).toBe('WrappedUSDC')
      expect(meta.symbol).toBe('USDC')
      expect(meta.decimals).toBe(6)
      expect(meta.totalSupply).toBe('1000000000000')
    })
  })

  describe('subscribeBlocks', () => {
    it('should subscribe and receive block notifications', async () => {
      let callCount = 0
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({ status: { erd_nonce: 100 } }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({ status: { erd_nonce: 101 } }),
        } as unknown as Response)

      const blocks: number[] = []
      const unsubscribe = await provider.subscribeBlocks((blockNumber) => {
        blocks.push(blockNumber)
        callCount++
        if (callCount >= 2) {
          unsubscribe()
        }
      })

      // Wait a bit for the first poll
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(blocks.length).toBeGreaterThanOrEqual(1)
      expect(blocks[0]).toBe(100)

      // Cleanup
      unsubscribe()
    })
  })

  describe('estimateGas', () => {
    it('should return estimated gas units', async () => {
      mockFetchResponse({ txGasUnits: 12000000 })

      const gas = await provider.estimateGas(
        'erd1qqqqqqqqqqqqqpgqcontract',
        'myFunction',
      )

      expect(gas).toBe('12000000')
    })

    it('should return default on failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'))

      const gas = await provider.estimateGas(
        'erd1qqqqqqqqqqqqqpgqcontract',
        'myFunction',
      )

      expect(gas).toBe('6000000')
    })
  })
})
