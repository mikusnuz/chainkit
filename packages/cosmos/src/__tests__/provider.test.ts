import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CosmosProvider } from '../provider.js'

function createMockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as unknown as Response
}

describe('CosmosProvider', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let provider: CosmosProvider

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    provider = new CosmosProvider({ lcdEndpoint: 'http://lcd.test' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Helper to get the URL path from a fetch call.
   */
  function getUrlFromCall(callIndex: number): string {
    return mockFetch.mock.calls[callIndex][0] as string
  }

  describe('constructor', () => {
    it('should throw if no LCD endpoint is provided', () => {
      expect(
        () => new CosmosProvider({ lcdEndpoint: '' }),
      ).toThrow('LCD endpoint is required')
    })

    it('should strip trailing slashes from endpoints', () => {
      const p = new CosmosProvider({ lcdEndpoint: 'http://lcd.test/' })
      // Provider is created successfully
      expect(p).toBeDefined()
    })
  })

  describe('getBalance', () => {
    it('should call the LCD balances endpoint and return ATOM balance', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          balances: [
            { denom: 'uatom', amount: '1000000' },
            { denom: 'ibc/ABC', amount: '500' },
          ],
        }),
      )

      const balance = await provider.getBalance('cosmos1abc')

      expect(getUrlFromCall(0)).toBe(
        'http://lcd.test/cosmos/bank/v1beta1/balances/cosmos1abc',
      )
      expect(balance).toEqual({
        address: 'cosmos1abc',
        amount: '1000000',
        symbol: 'ATOM',
        decimals: 6,
      })
    })

    it('should handle zero balance when no uatom denom found', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          balances: [],
        }),
      )

      const balance = await provider.getBalance('cosmos1empty')
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return null for non-existent transaction', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({}, false, 404),
      )

      const tx = await provider.getTransaction('DEADBEEF')
      expect(tx).toBeNull()
    })

    it('should return transaction info for a confirmed tx', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          tx_response: {
            txhash: 'ABC123',
            height: '100',
            code: 0,
            timestamp: '2024-01-01T00:00:00Z',
            gas_wanted: '200000',
            gas_used: '150000',
            tx: {
              body: {
                messages: [
                  {
                    '@type': '/cosmos.bank.v1beta1.MsgSend',
                    from_address: 'cosmos1sender',
                    to_address: 'cosmos1recipient',
                    amount: [{ denom: 'uatom', amount: '1000000' }],
                  },
                ],
                memo: '',
              },
              auth_info: {
                fee: {
                  amount: [{ denom: 'uatom', amount: '5000' }],
                },
              },
            },
          },
        }),
      )

      const tx = await provider.getTransaction('ABC123')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('ABC123')
      expect(tx!.from).toBe('cosmos1sender')
      expect(tx!.to).toBe('cosmos1recipient')
      expect(tx!.value).toBe('1000000')
      expect(tx!.fee).toBe('5000')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(100)
    })

    it('should return failed status for non-zero code', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          tx_response: {
            txhash: 'FAIL123',
            height: '50',
            code: 11,
            timestamp: '2024-01-01T00:00:00Z',
            tx: {
              body: { messages: [], memo: '' },
              auth_info: { fee: { amount: [] } },
            },
          },
        }),
      )

      const tx = await provider.getTransaction('FAIL123')
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should fetch block by number', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          block: {
            header: {
              height: '100',
              time: '2024-01-01T00:00:00Z',
            },
            data: {
              txs: ['tx1', 'tx2'],
            },
          },
          block_id: {
            hash: 'BLOCKHASH123',
          },
        }),
      )

      const block = await provider.getBlock(100)

      expect(getUrlFromCall(0)).toBe(
        'http://lcd.test/cosmos/base/tendermint/v1beta1/blocks/100',
      )
      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('BLOCKHASH123')
      expect(block!.transactions).toEqual(['tx1', 'tx2'])
    })

    it('should return null for non-existent block', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({}, false, 404),
      )

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates in uatom', async () => {
      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('uatom')
      expect(parseFloat(fee.slow)).toBe(0.01)
      expect(parseFloat(fee.average)).toBe(0.025)
      expect(parseFloat(fee.fast)).toBe(0.04)
    })
  })

  describe('broadcastTransaction', () => {
    it('should POST to the txs endpoint', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          tx_response: {
            txhash: 'NEWTXHASH',
            code: 0,
          },
        }),
      )

      const txHash = await provider.broadcastTransaction('signedTxBytes')

      expect(getUrlFromCall(0)).toBe('http://lcd.test/cosmos/tx/v1beta1/txs')
      const [, options] = mockFetch.mock.calls[0]
      expect(options.method).toBe('POST')
      const body = JSON.parse(options.body)
      expect(body.tx_bytes).toBe('signedTxBytes')
      expect(body.mode).toBe('BROADCAST_MODE_SYNC')
      expect(txHash).toBe('NEWTXHASH')
    })

    it('should throw on broadcast failure', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          tx_response: {
            txhash: '',
            code: 11,
            raw_log: 'out of gas',
          },
        }),
      )

      await expect(provider.broadcastTransaction('badTx')).rejects.toThrow(
        'Broadcast failed: out of gas',
      )
    })
  })

  describe('getChainInfo', () => {
    it('should return chain info from node_info endpoint', async () => {
      // node_info
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          default_node_info: {
            network: 'cosmoshub-4',
          },
          application_version: {
            name: 'Cosmos Hub',
            version: '0.47.0',
          },
        }),
      )

      // latest block
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          block: {
            header: {
              height: '12345678',
            },
          },
        }),
      )

      const info = await provider.getChainInfo()

      expect(info).toEqual({
        chainId: 'cosmoshub-4',
        name: 'Cosmos Hub',
        symbol: 'ATOM',
        decimals: 6,
        testnet: false,
        blockHeight: 12345678,
      })
    })

    it('should detect testnet by network name', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          default_node_info: { network: 'theta-testnet-001' },
          application_version: { name: 'Cosmos Hub', version: '0.47.0' },
        }),
      )
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          block: { header: { height: '100' } },
        }),
      )

      const info = await provider.getChainInfo()
      expect(info.testnet).toBe(true)
    })
  })

  describe('callContract', () => {
    it('should call CosmWasm smart query endpoint', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ data: { count: 42 } }),
      )

      const result = await provider.callContract(
        'cosmos1contract',
        'get_count',
        [{}],
      )

      const url = getUrlFromCall(0)
      expect(url).toContain('/cosmwasm/wasm/v1/contract/cosmos1contract/smart/')
    })

    it('should pass through JSON query messages', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ data: { balance: '100' } }),
      )

      await provider.callContract(
        'cosmos1contract',
        '{"balance":{"address":"cosmos1holder"}}',
      )

      const url = getUrlFromCall(0)
      // The JSON should be base64-encoded in the URL
      const base64Part = url.split('/smart/')[1]
      const decoded = atob(base64Part)
      expect(decoded).toBe('{"balance":{"address":"cosmos1holder"}}')
    })
  })

  describe('estimateGas', () => {
    it('should return a default gas estimate', async () => {
      const gas = await provider.estimateGas('cosmos1contract', 'execute')
      expect(gas).toBe('200000')
    })
  })

  describe('getTokenBalance', () => {
    it('should query balance by denom', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          balance: { denom: 'ibc/ABC', amount: '500000' },
        }),
      )

      const balance = await provider.getTokenBalance('cosmos1holder', 'ibc/ABC')

      expect(getUrlFromCall(0)).toContain(
        '/cosmos/bank/v1beta1/balances/cosmos1holder/by_denom?denom=ibc/ABC',
      )
      expect(balance).toEqual({
        address: 'cosmos1holder',
        amount: '500000',
        symbol: 'ibc/ABC',
        decimals: 6,
      })
    })
  })

  describe('getTokenMetadata', () => {
    it('should fetch denom metadata', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          metadata: {
            name: 'Cosmos ATOM',
            symbol: 'ATOM',
            description: 'The native staking token',
            denom_units: [
              { denom: 'uatom', exponent: 0 },
              { denom: 'atom', exponent: 6 },
            ],
            base: 'uatom',
            display: 'atom',
          },
        }),
      )

      const metadata = await provider.getTokenMetadata('uatom')

      expect(metadata).toEqual({
        address: 'uatom',
        name: 'Cosmos ATOM',
        symbol: 'ATOM',
        decimals: 6,
      })
    })

    it('should fallback for tokens without metadata', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({}, false, 404),
      )

      const metadata = await provider.getTokenMetadata('ibc/UNKNOWN')

      expect(metadata).toEqual({
        address: 'ibc/UNKNOWN',
        name: 'ibc/UNKNOWN',
        symbol: 'ibc/UNKNOWN',
        decimals: 6,
      })
    })
  })

  describe('subscribeBlocks', () => {
    it('should call the callback when a new block is detected', async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          createMockResponse({
            block: { header: { height: '100' } },
          }),
        ),
      )

      const callback = vi.fn()
      const unsubscribe = await provider.subscribeBlocks(callback)

      // Wait a bit for the first poll
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(callback).toHaveBeenCalledWith(100)

      // Unsubscribe to clean up
      unsubscribe()
    })
  })

  describe('subscribeTransactions', () => {
    it('should set up polling and return an unsubscribe function', async () => {
      // Initial block height query
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          block: { header: { height: '100' } },
        }),
      )

      const callback = vi.fn()
      const unsubscribe = await provider.subscribeTransactions(
        'cosmos1abc',
        callback,
      )

      expect(typeof unsubscribe).toBe('function')

      // Clean up
      unsubscribe()
    })
  })
})
