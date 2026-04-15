import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FilecoinProvider } from './provider.js'

// Mock the RpcManager
vi.mock('@chainkit/core', async () => {
  const actual = await vi.importActual('@chainkit/core')
  return {
    ...actual,
    RpcManager: vi.fn().mockImplementation(() => ({
      request: vi.fn(),
    })),
  }
})

describe('FilecoinProvider', () => {
  let provider: FilecoinProvider
  let mockRequest: ReturnType<typeof vi.fn>

  beforeEach(() => {
    provider = new FilecoinProvider({
      endpoints: ['https://api.calibration.node.glif.io/rpc/v1'],
    })
    // Access the mocked rpc.request
    mockRequest = (provider as any).rpc.request
  })

  describe('getBalance', () => {
    it('should return balance for an address', async () => {
      mockRequest.mockResolvedValue({
        Balance: '1000000000000000000',
      })

      const balance = await provider.getBalance('f1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za')

      expect(balance).toEqual({
        address: 'f1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za',
        amount: '1000000000000000000',
        symbol: 'FIL',
        decimals: 18,
      })
      expect(mockRequest).toHaveBeenCalledWith(
        'Filecoin.StateGetActor',
        ['f1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za', null],
      )
    })

    it('should return zero balance when actor not found', async () => {
      mockRequest.mockResolvedValue(null)

      const balance = await provider.getBalance('f1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za')

      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info for a valid CID', async () => {
      mockRequest
        .mockResolvedValueOnce({
          From: 'f1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za',
          To: 'f1defg1234567890abcdef1234567890abcdefgh',
          Value: '500000000000000000',
          Nonce: 5,
        })
        .mockResolvedValueOnce({
          Receipt: { ExitCode: 0, GasUsed: '1234567' },
          Height: 100,
        })

      const tx = await provider.getTransaction('bafy2bzacetest1234567890')

      expect(tx).not.toBeNull()
      expect(tx!.from).toBe('f1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za')
      expect(tx!.value).toBe('500000000000000000')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.nonce).toBe(5)
    })

    it('should return null for non-existent transaction', async () => {
      mockRequest.mockRejectedValue(new Error('not found'))

      const tx = await provider.getTransaction('bafy2bzacenonexistent')

      expect(tx).toBeNull()
    })
  })

  describe('getBlock', () => {
    it('should return block info by height', async () => {
      mockRequest.mockResolvedValue({
        Cids: [{ '/': 'bafy2bzaceblock1' }],
        Blocks: [
          {
            Timestamp: 1700000000,
            Parents: [{ '/': 'bafy2bzaceparent1' }],
          },
        ],
        Height: 100,
      })

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('bafy2bzaceblock1')
      expect(block!.parentHash).toBe('bafy2bzaceparent1')
      expect(block!.timestamp).toBe(1700000000)
    })

    it('should return null for non-existent block', async () => {
      mockRequest.mockResolvedValue(null)

      const block = await provider.getBlock(999999999)

      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates', async () => {
      mockRequest.mockResolvedValue({
        Height: 100,
        Blocks: [{ ParentBaseFee: '100000000' }],
      })

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('nanoFIL')
      expect(parseFloat(fee.slow)).toBeGreaterThan(0)
      expect(parseFloat(fee.average)).toBeGreaterThan(parseFloat(fee.slow))
      expect(parseFloat(fee.fast)).toBeGreaterThan(parseFloat(fee.average))
    })

    it('should return fallback fees on error', async () => {
      mockRequest.mockRejectedValue(new Error('network error'))

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('nanoFIL')
      expect(fee.slow).toBe('0.0001')
    })
  })

  describe('getChainInfo', () => {
    it('should return chain info', async () => {
      mockRequest
        .mockResolvedValueOnce({ Height: 500 })
        .mockResolvedValueOnce('calibrationnet')

      const info = await provider.getChainInfo()

      expect(info.symbol).toBe('FIL')
      expect(info.decimals).toBe(18)
      expect(info.blockHeight).toBe(500)
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a signed message', async () => {
      mockRequest.mockResolvedValue({ '/': 'bafy2bzacetxhash' })

      const signedMessage = JSON.stringify({
        Message: {
          To: 'f1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za',
          From: 'f1defg1234567890abcdef1234567890abcdefgh',
          Value: '100',
          Nonce: 0,
          GasLimit: 1000000,
          GasFeeCap: '100000',
          GasPremium: '10000',
          Method: 0,
          Params: '',
        },
        Signature: {
          Type: 1,
          Data: 'AAAA',
        },
      })

      const txHash = await provider.broadcastTransaction(signedMessage)

      expect(txHash).toBe('bafy2bzacetxhash')
    })
  })

  describe('subscribeBlocks', () => {
    it('should subscribe and call callback on new blocks', async () => {
      let callCount = 0
      mockRequest.mockResolvedValue({ Height: 100 })

      const unsubscribe = await provider.subscribeBlocks((blockNumber) => {
        callCount++
        expect(blockNumber).toBe(100)
      })

      // Wait a tick for the first poll
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(callCount).toBe(1)
      unsubscribe()
    })
  })
})
