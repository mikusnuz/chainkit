import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EthereumProvider } from '../provider.js'

function createMockResponse(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ jsonrpc: '2.0', result }),
  } as unknown as Response
}

describe('EthereumProvider', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let provider: EthereumProvider

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    provider = new EthereumProvider({ endpoints: ['http://rpc.test'] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Helper to get the RPC method name from a fetch call.
   */
  function getMethodFromCall(callIndex: number): string {
    const [, options] = mockFetch.mock.calls[callIndex]
    const body = JSON.parse(options.body)
    return body.method
  }

  /**
   * Helper to get the RPC params from a fetch call.
   */
  function getParamsFromCall(callIndex: number): unknown[] {
    const [, options] = mockFetch.mock.calls[callIndex]
    const body = JSON.parse(options.body)
    return body.params
  }

  describe('getBalance', () => {
    it('should call eth_getBalance and return parsed balance', async () => {
      // 1 ETH = 1e18 wei = 0xde0b6b3a7640000
      mockFetch.mockResolvedValueOnce(createMockResponse('0xde0b6b3a7640000'))

      const balance = await provider.getBalance('0x1234567890abcdef1234567890abcdef12345678')

      expect(getMethodFromCall(0)).toBe('eth_getBalance')
      expect(getParamsFromCall(0)).toEqual([
        '0x1234567890abcdef1234567890abcdef12345678',
        'latest',
      ])
      expect(balance).toEqual({
        address: '0x1234567890abcdef1234567890abcdef12345678',
        amount: '1000000000000000000',
        symbol: 'ETH',
        decimals: 18,
      })
    })

    it('should handle zero balance', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('0x0'))

      const balance = await provider.getBalance('0xabc')
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return null for non-existent transaction', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(null))

      const tx = await provider.getTransaction('0xdeadbeef')
      expect(tx).toBeNull()
    })

    it('should return transaction info for confirmed tx', async () => {
      // First call: eth_getTransactionByHash
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          hash: '0xabc123',
          from: '0xsender',
          to: '0xrecipient',
          value: '0xde0b6b3a7640000',
          blockNumber: '0xa',
          blockHash: '0xblockhash123456789012345678901234567890123456789012345678901234',
          nonce: '0x5',
          input: '0x',
          gasPrice: '0x4a817c800',
        }),
      )

      // Second call: eth_getTransactionReceipt
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: '0x1',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x4a817c800',
        }),
      )

      // Third call: eth_getBlockByHash (for timestamp)
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          timestamp: '0x60000000',
        }),
      )

      const tx = await provider.getTransaction('0xabc123')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('0xabc123')
      expect(tx!.from).toBe('0xsender')
      expect(tx!.to).toBe('0xrecipient')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(10)
      expect(tx!.nonce).toBe(5)
      expect(tx!.value).toBe('1000000000000000000')

      // Verify correct methods called
      expect(getMethodFromCall(0)).toBe('eth_getTransactionByHash')
      expect(getMethodFromCall(1)).toBe('eth_getTransactionReceipt')
      expect(getMethodFromCall(2)).toBe('eth_getBlockByHash')
    })

    it('should return pending status for unconfirmed tx', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          hash: '0xpending',
          from: '0xsender',
          to: '0xrecipient',
          value: '0x0',
          blockNumber: null,
          blockHash: null,
          nonce: '0x0',
          input: '0x',
        }),
      )

      const tx = await provider.getTransaction('0xpending')
      expect(tx!.status).toBe('pending')
      expect(tx!.blockNumber).toBeNull()
    })
  })

  describe('getBlock', () => {
    it('should fetch block by number', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          number: '0x10',
          hash: '0xblockhash',
          parentHash: '0xparenthash',
          timestamp: '0x60000000',
          transactions: ['0xtx1', '0xtx2'],
        }),
      )

      const block = await provider.getBlock(16)

      expect(getMethodFromCall(0)).toBe('eth_getBlockByNumber')
      expect(getParamsFromCall(0)).toEqual(['0x10', false])
      expect(block).not.toBeNull()
      expect(block!.number).toBe(16)
      expect(block!.hash).toBe('0xblockhash')
      expect(block!.transactions).toEqual(['0xtx1', '0xtx2'])
    })

    it('should fetch block by hash', async () => {
      const hash = '0x' + 'ab'.repeat(32) // 64 hex chars
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          number: '0x1',
          hash,
          parentHash: '0xparent',
          timestamp: '0x1',
          transactions: [],
        }),
      )

      const block = await provider.getBlock(hash)
      expect(getMethodFromCall(0)).toBe('eth_getBlockByHash')
    })

    it('should return null for non-existent block', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(null))
      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates in gwei', async () => {
      // eth_getBlockByNumber (latest)
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          baseFeePerGas: '0x3b9aca00', // 1 gwei
          number: '0x1',
        }),
      )

      // eth_maxPriorityFeePerGas
      mockFetch.mockResolvedValueOnce(
        createMockResponse('0x77359400'), // 2 gwei
      )

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('wei')
      // Slow: 1 gwei + 2 gwei = 3 gwei = 3000000000 wei
      expect(BigInt(fee.slow)).toBe(3000000000n)
      // Average: 1 * 1.25 + 2 * 1.5 = 1.25 + 3 = 4.25 gwei = 4250000000 wei
      expect(BigInt(fee.average)).toBe(4250000000n)
      // Fast: 1 * 1.5 + 2 * 2 = 1.5 + 4 = 5.5 gwei = 5500000000 wei
      expect(BigInt(fee.fast)).toBe(5500000000n)
    })
  })

  describe('broadcastTransaction', () => {
    it('should call eth_sendRawTransaction', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('0xtxhash'))

      const txHash = await provider.broadcastTransaction('0xsignedtx')

      expect(getMethodFromCall(0)).toBe('eth_sendRawTransaction')
      expect(getParamsFromCall(0)).toEqual(['0xsignedtx'])
      expect(txHash).toBe('0xtxhash')
    })
  })

  describe('getChainInfo', () => {
    it('should return chain info for mainnet', async () => {
      // eth_chainId
      mockFetch.mockResolvedValueOnce(createMockResponse('0x1'))
      // eth_blockNumber
      mockFetch.mockResolvedValueOnce(createMockResponse('0xf4240')) // 1000000

      const info = await provider.getChainInfo()

      expect(info).toEqual({
        chainId: '1',
        name: 'Ethereum Mainnet',
        symbol: 'ETH',
        decimals: 18,
        testnet: false,
        blockHeight: 1000000,
      })
    })

    it('should return chain info for Sepolia', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('0xaa36a7')) // 11155111
      mockFetch.mockResolvedValueOnce(createMockResponse('0x100'))

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Sepolia')
      expect(info.testnet).toBe(true)
    })

    it('should handle unknown chain IDs', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('0x539')) // 1337
      mockFetch.mockResolvedValueOnce(createMockResponse('0x1'))

      const info = await provider.getChainInfo()
      expect(info.name).toBe('EVM Chain 1337')
    })
  })

  describe('callContract', () => {
    it('should call eth_call with encoded function selector', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('0x000000000000000000000000000000000000000000000000000000000000002a'))

      const result = await provider.callContract(
        '0xcontract',
        'balanceOf(address)',
        ['0x1234567890abcdef1234567890abcdef12345678'],
      )

      expect(getMethodFromCall(0)).toBe('eth_call')
      const params = getParamsFromCall(0) as [{ to: string; data: string }, string]
      expect(params[0].to).toBe('0xcontract')
      // Should start with balanceOf selector: 0x70a08231
      expect(params[0].data).toMatch(/^0x70a08231/)
      expect(params[1]).toBe('latest')
    })

    it('should pass through pre-encoded call data', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('0xresult'))

      await provider.callContract('0xcontract', '0x12345678')

      const params = getParamsFromCall(0) as [{ to: string; data: string }, string]
      expect(params[0].data).toBe('0x12345678')
    })
  })

  describe('estimateGas', () => {
    it('should call eth_estimateGas', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('0x5208')) // 21000

      const gas = await provider.estimateGas(
        '0xcontract',
        'transfer(address,uint256)',
        ['0xrecipient', 100n],
      )

      expect(getMethodFromCall(0)).toBe('eth_estimateGas')
      expect(gas).toBe('21000')
    })
  })

  describe('getTokenBalance', () => {
    it('should call eth_call for balanceOf, decimals, and symbol', async () => {
      // balanceOf
      mockFetch.mockResolvedValueOnce(
        createMockResponse('0x00000000000000000000000000000000000000000000003635c9adc5dea00000'), // 1000e18
      )
      // decimals
      mockFetch.mockResolvedValueOnce(
        createMockResponse('0x0000000000000000000000000000000000000000000000000000000000000012'), // 18
      )
      // symbol - ABI-encoded "USDC"
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          '0x' +
            '0000000000000000000000000000000000000000000000000000000000000020' + // offset
            '0000000000000000000000000000000000000000000000000000000000000004' + // length = 4
            '5553444300000000000000000000000000000000000000000000000000000000', // "USDC"
        ),
      )

      const balance = await provider.getTokenBalance(
        '0xholder',
        '0xtokencontract',
      )

      expect(balance.symbol).toBe('USDC')
      expect(balance.decimals).toBe(18)
      expect(balance.address).toBe('0xholder')
      // All three calls should be eth_call
      expect(getMethodFromCall(0)).toBe('eth_call')
      expect(getMethodFromCall(1)).toBe('eth_call')
      expect(getMethodFromCall(2)).toBe('eth_call')
    })
  })

  describe('getTokenMetadata', () => {
    it('should fetch name, symbol, decimals, and totalSupply', async () => {
      // name
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          '0x' +
            '0000000000000000000000000000000000000000000000000000000000000020' +
            '0000000000000000000000000000000000000000000000000000000000000009' +
            '5465737420436f696e0000000000000000000000000000000000000000000000',
        ),
      )
      // symbol
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          '0x' +
            '0000000000000000000000000000000000000000000000000000000000000020' +
            '0000000000000000000000000000000000000000000000000000000000000003' +
            '5453540000000000000000000000000000000000000000000000000000000000',
        ),
      )
      // decimals
      mockFetch.mockResolvedValueOnce(
        createMockResponse('0x0000000000000000000000000000000000000000000000000000000000000012'),
      )
      // totalSupply
      mockFetch.mockResolvedValueOnce(
        createMockResponse('0x00000000000000000000000000000000000000000000d3c21bcecceda1000000'), // 1e24
      )

      const meta = await provider.getTokenMetadata('0xtokencontract')

      expect(meta.address).toBe('0xtokencontract')
      expect(meta.name).toBe('Test Coin')
      expect(meta.symbol).toBe('TST')
      expect(meta.decimals).toBe(18)
      expect(meta.totalSupply).toBe('1000000000000000000000000')
    })
  })

  describe('subscribeBlocks', () => {
    it('should call the callback when a new block is detected', async () => {
      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        return Promise.resolve(createMockResponse('0xa')) // block 10
      })

      const callback = vi.fn()
      const unsubscribe = await provider.subscribeBlocks(callback)

      // Wait a bit for the first poll
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(callback).toHaveBeenCalledWith(10)

      // Unsubscribe to clean up
      unsubscribe()
    })
  })

  describe('subscribeTransactions', () => {
    it('should set up polling and return an unsubscribe function', async () => {
      // Initial eth_blockNumber call
      mockFetch.mockResolvedValueOnce(createMockResponse('0xa'))

      const callback = vi.fn()
      const unsubscribe = await provider.subscribeTransactions(
        '0x1234567890abcdef1234567890abcdef12345678',
        callback,
      )

      expect(typeof unsubscribe).toBe('function')

      // Clean up
      unsubscribe()
    })
  })
})
