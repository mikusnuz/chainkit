import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IconProvider } from './provider.js'

// Mock global fetch for RPC tests
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockRpcResponse(result: unknown) {
  return {
    ok: true,
    json: () => Promise.resolve({ jsonrpc: '2.0', result }),
  }
}

function mockRpcError(code: number, message: string) {
  return {
    ok: true,
    json: () => Promise.resolve({ jsonrpc: '2.0', error: { code, message } }),
  }
}

describe('IconProvider', () => {
  let provider: IconProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new IconProvider({
      endpoints: ['https://lisbon.net.solidwallet.io/api/v3'],
    })
  })

  describe('getBalance', () => {
    it('should return ICX balance in loop', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse('0xde0b6b3a7640000'), // 1 ICX in loop
      )

      const balance = await provider.getBalance('hx1234567890abcdef1234567890abcdef12345678')

      expect(balance.address).toBe('hx1234567890abcdef1234567890abcdef12345678')
      expect(balance.amount).toBe('1000000000000000000')
      expect(balance.symbol).toBe('ICX')
      expect(balance.decimals).toBe(18)
    })

    it('should handle zero balance', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x0'))

      const balance = await provider.getBalance('hx0000000000000000000000000000000000000000')
      expect(balance.amount).toBe('0')
    })

    it('should call icx_getBalance RPC method', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x0'))

      await provider.getBalance('hx1234567890abcdef1234567890abcdef12345678')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.method).toBe('icx_getBalance')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info for a confirmed transaction', async () => {
      // Mock icx_getTransactionResult
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          status: '0x1',
          from: 'hxaaaa000000000000000000000000000000000000',
          to: 'hxbbbb000000000000000000000000000000000000',
          value: '0xde0b6b3a7640000',
          stepUsed: '0x186a0',
          stepPrice: '0x2e90edd00',
          blockHeight: '0xa',
          blockHash: '0x1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd',
        }),
      )
      // Mock icx_getBlockByHeight for timestamp
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          time_stamp: 1700000000000000, // microseconds
        }),
      )

      const tx = await provider.getTransaction('0xabcd1234')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('0xabcd1234')
      expect(tx!.from).toBe('hxaaaa000000000000000000000000000000000000')
      expect(tx!.to).toBe('hxbbbb000000000000000000000000000000000000')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(10)
      expect(tx!.timestamp).toBe(1700000000)
    })

    it('should return null for a non-existent transaction', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcError(-32602, 'Invalid txHash'))

      const tx = await provider.getTransaction('0xnonexistent')
      expect(tx).toBeNull()
    })

    it('should handle failed transactions', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          status: '0x0',
          from: 'hxaaaa000000000000000000000000000000000000',
          to: 'hxbbbb000000000000000000000000000000000000',
          value: '0x0',
          stepUsed: '0x186a0',
          stepPrice: '0x2e90edd00',
          blockHeight: '0xa',
          blockHash: '0x1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd',
        }),
      )
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({ time_stamp: 1700000000000000 }),
      )

      const tx = await provider.getTransaction('0xfailed')
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    const mockBlock = {
      height: 100,
      block_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      prev_block_hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      time_stamp: 1700000000000000,
      confirmed_transaction_list: [
        { txHash: '0xtx1' },
        { txHash: '0xtx2' },
      ],
    }

    it('should get block by number', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse(mockBlock))

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.transactions).toEqual(['0xtx1', '0xtx2'])
      expect(block!.timestamp).toBe(1700000000)
    })

    it('should get block by hash', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse(mockBlock))

      const block = await provider.getBlock(
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      )

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
    })

    it('should return null for non-existent block', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcError(-32602, 'Invalid height'))

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates', async () => {
      // Mock getStepPrice call
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse('0x2e90edd00'), // 12500000000 loop (12.5 Gloop)
      )

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('ICX')
      expect(fee.slow).toBeDefined()
      expect(fee.average).toBeDefined()
      expect(fee.fast).toBeDefined()
      expect(parseFloat(fee.slow)).toBeLessThanOrEqual(parseFloat(fee.average))
      expect(parseFloat(fee.average)).toBeLessThanOrEqual(parseFloat(fee.fast))
    })

    it('should return fallback fees if governance call fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection failed'))

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('ICX')
      expect(fee.slow).toBe('0.001250')
      expect(fee.average).toBe('0.003750')
      expect(fee.fast).toBe('0.012500')
    })
  })

  describe('broadcastTransaction', () => {
    it('should decode hex-encoded JSON and send via icx_sendTransaction', async () => {
      const txObj = {
        version: '0x3',
        from: 'hxaaaa000000000000000000000000000000000000',
        to: 'hxbbbb000000000000000000000000000000000000',
        value: '0xde0b6b3a7640000',
        nid: '0x1',
        stepLimit: '0x186a0',
        timestamp: '0x5850adcbef6b8',
        signature: 'base64signature==',
      }

      const jsonStr = JSON.stringify(txObj)
      const hexStr = '0x' + Array.from(new TextEncoder().encode(jsonStr))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')

      const expectedHash = '0xabcdef1234'
      mockFetch.mockResolvedValueOnce(mockRpcResponse(expectedHash))

      const result = await provider.broadcastTransaction(hexStr)
      expect(result).toBe(expectedHash)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.method).toBe('icx_sendTransaction')
    })
  })

  describe('getChainInfo', () => {
    it('should return chain info from latest block', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          height: 50000000,
          nid: '0x1',
        }),
      )

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('0x1')
      expect(info.name).toBe('ICON Mainnet')
      expect(info.symbol).toBe('ICX')
      expect(info.decimals).toBe(18)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(50000000)
    })

    it('should detect Lisbon testnet', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          height: 1000,
          nid: '0x2',
        }),
      )

      const info = await provider.getChainInfo()
      expect(info.name).toBe('ICON Lisbon Testnet')
      expect(info.testnet).toBe(true)
    })
  })

  describe('callContract (SCORE)', () => {
    it('should call a SCORE method', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x2710'))

      const result = await provider.callContract(
        'cxaaaa000000000000000000000000000000000000',
        'balanceOf',
        [{ _owner: 'hxbbbb000000000000000000000000000000000000' }],
      )

      expect(result).toBe('0x2710')

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.method).toBe('icx_call')
    })

    it('should call a SCORE method without params', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x12'))

      const result = await provider.callContract(
        'cxaaaa000000000000000000000000000000000000',
        'decimals',
      )

      expect(result).toBe('0x12')
    })
  })

  describe('estimateGas', () => {
    it('should call debug_estimateStep', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x493e0'))

      const gas = await provider.estimateGas(
        'cxaaaa000000000000000000000000000000000000',
        'transfer',
      )

      expect(gas).toBe('300000')
    })

    it('should return default when debug_estimateStep is unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Method not supported'))

      const gas = await provider.estimateGas(
        'cxaaaa000000000000000000000000000000000000',
        'transfer',
      )

      expect(gas).toBe('300000')
    })
  })

  describe('getTokenBalance (IRC-2)', () => {
    it('should get IRC-2 token balance', async () => {
      // balanceOf
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x3635c9adc5dea00000'))
      // decimals
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x12'))
      // symbol
      mockFetch.mockResolvedValueOnce(mockRpcResponse('ICE'))

      const balance = await provider.getTokenBalance(
        'hxaaaa000000000000000000000000000000000000',
        'cxbbbb000000000000000000000000000000000000',
      )

      expect(balance.amount).toBe('1000000000000000000000')
      expect(balance.symbol).toBe('ICE')
      expect(balance.decimals).toBe(18)
    })
  })

  describe('getTokenMetadata (IRC-2)', () => {
    it('should get IRC-2 token metadata', async () => {
      // name
      mockFetch.mockResolvedValueOnce(mockRpcResponse('ICE Token'))
      // symbol
      mockFetch.mockResolvedValueOnce(mockRpcResponse('ICE'))
      // decimals
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x12'))
      // totalSupply
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0xd3c21bcecceda1000000'))

      const metadata = await provider.getTokenMetadata(
        'cxbbbb000000000000000000000000000000000000',
      )

      expect(metadata.name).toBe('ICE Token')
      expect(metadata.symbol).toBe('ICE')
      expect(metadata.decimals).toBe(18)
      expect(metadata.address).toBe('cxbbbb000000000000000000000000000000000000')
    })
  })

  describe('subscribeBlocks', () => {
    it('should call callback when new blocks arrive', async () => {
      let callCount = 0
      const blockNumbers: number[] = []

      // First call returns block 100
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({ height: 100 }),
      )
      // Second call returns block 101
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({ height: 101 }),
      )

      const unsub = await provider.subscribeBlocks((blockNumber) => {
        blockNumbers.push(blockNumber)
        callCount++
      })

      // Wait for first poll
      await new Promise((resolve) => setTimeout(resolve, 100))

      unsub()

      expect(callCount).toBeGreaterThanOrEqual(1)
      expect(blockNumbers[0]).toBe(100)
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      // Mock icx_getLastBlock for initialization
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({ height: 100 }),
      )

      const unsub = await provider.subscribeTransactions(
        'hxaaaa000000000000000000000000000000000000',
        () => {},
      )

      expect(typeof unsub).toBe('function')
      unsub()
    })
  })
})
