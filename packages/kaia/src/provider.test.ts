import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KaiaProvider } from './provider.js'

// Mock the RpcManager
vi.mock('@chainkit/core', async () => {
  const actual = await vi.importActual<typeof import('@chainkit/core')>('@chainkit/core')
  return {
    ...actual,
    RpcManager: vi.fn().mockImplementation(() => ({
      request: vi.fn(),
    })),
  }
})

describe('KaiaProvider', () => {
  let provider: KaiaProvider
  let mockRequest: ReturnType<typeof vi.fn>

  beforeEach(() => {
    provider = new KaiaProvider({ url: 'https://public-en.node.kaia.io' })
    // Access the mocked rpc.request
    mockRequest = (provider as any).rpc.request
  })

  describe('getBalance', () => {
    it('should fetch KLAY balance using klay_getBalance', async () => {
      mockRequest.mockResolvedValueOnce('0xde0b6b3a7640000') // 1 KLAY in peb

      const balance = await provider.getBalance('0x1234567890abcdef1234567890abcdef12345678')

      expect(mockRequest).toHaveBeenCalledWith('klay_getBalance', [
        '0x1234567890abcdef1234567890abcdef12345678',
        'latest',
      ])
      expect(balance).toEqual({
        address: '0x1234567890abcdef1234567890abcdef12345678',
        amount: '1000000000000000000',
        symbol: 'KLAY',
        decimals: 18,
      })
    })

    it('should handle zero balance', async () => {
      mockRequest.mockResolvedValueOnce('0x0')

      const balance = await provider.getBalance('0x1234567890abcdef1234567890abcdef12345678')

      expect(balance.amount).toBe('0')
      expect(balance.symbol).toBe('KLAY')
    })
  })

  describe('getTransaction', () => {
    it('should return null for non-existent transaction', async () => {
      mockRequest.mockResolvedValueOnce(null)

      const tx = await provider.getTransaction('0xdeadbeef')

      expect(mockRequest).toHaveBeenCalledWith('klay_getTransactionByHash', ['0xdeadbeef'])
      expect(tx).toBeNull()
    })

    it('should fetch and parse a confirmed transaction', async () => {
      const mockTx = {
        hash: '0xabc123',
        from: '0xsender',
        to: '0xreceiver',
        value: '0xde0b6b3a7640000',
        blockNumber: '0xa',
        blockHash: '0xblockhash',
        input: '0x',
        nonce: '0x1',
        gasPrice: '0x3b9aca00',
      }

      const mockReceipt = {
        status: '0x1',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x3b9aca00',
      }

      const mockBlock = {
        timestamp: '0x60000000',
      }

      mockRequest
        .mockResolvedValueOnce(mockTx)
        .mockResolvedValueOnce(mockReceipt)
        .mockResolvedValueOnce(mockBlock)

      const tx = await provider.getTransaction('0xabc123')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('0xabc123')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.value).toBe('1000000000000000000')
      expect(tx!.blockNumber).toBe(10)
    })
  })

  describe('getBlock', () => {
    it('should fetch block by number', async () => {
      const mockBlock = {
        number: '0xa',
        hash: '0xblockhash',
        parentHash: '0xparenthash',
        timestamp: '0x60000000',
        transactions: ['0xtx1', '0xtx2'],
      }

      mockRequest.mockResolvedValueOnce(mockBlock)

      const block = await provider.getBlock(10)

      expect(mockRequest).toHaveBeenCalledWith('klay_getBlockByNumber', ['0xa', false])
      expect(block).not.toBeNull()
      expect(block!.number).toBe(10)
      expect(block!.transactions).toEqual(['0xtx1', '0xtx2'])
    })

    it('should fetch block by hash', async () => {
      const blockHash = '0x' + 'ab'.repeat(32)
      const mockBlock = {
        number: '0xa',
        hash: blockHash,
        parentHash: '0xparenthash',
        timestamp: '0x60000000',
        transactions: [],
      }

      mockRequest.mockResolvedValueOnce(mockBlock)

      const block = await provider.getBlock(blockHash)

      expect(mockRequest).toHaveBeenCalledWith('klay_getBlockByHash', [blockHash, false])
    })

    it('should return null for non-existent block', async () => {
      mockRequest.mockResolvedValueOnce(null)

      const block = await provider.getBlock(999999999)

      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should estimate fees with baseFee (post-Magma)', async () => {
      const mockBlock = {
        baseFeePerGas: '0x5d21dba00', // 25 Gpeb
      }

      mockRequest
        .mockResolvedValueOnce(mockBlock) // klay_getBlockByNumber
        .mockResolvedValueOnce('0x5d21dba00') // klay_gasPrice

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('Gpeb')
      expect(parseFloat(fee.slow)).toBeGreaterThan(0)
      expect(parseFloat(fee.average)).toBeGreaterThanOrEqual(parseFloat(fee.slow))
      expect(parseFloat(fee.fast)).toBeGreaterThanOrEqual(parseFloat(fee.average))
    })

    it('should fall back to gasPrice when no baseFee', async () => {
      const mockBlock = {} // no baseFeePerGas

      mockRequest
        .mockResolvedValueOnce(mockBlock)
        .mockResolvedValueOnce('0x5d21dba00') // 25 Gpeb

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('Gpeb')
      expect(parseFloat(fee.slow)).toBeGreaterThan(0)
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast using klay_sendRawTransaction', async () => {
      mockRequest.mockResolvedValueOnce('0xtxhash123')

      const txHash = await provider.broadcastTransaction('0xsignedtx')

      expect(mockRequest).toHaveBeenCalledWith('klay_sendRawTransaction', ['0xsignedtx'])
      expect(txHash).toBe('0xtxhash123')
    })
  })

  describe('getChainInfo', () => {
    it('should identify Kaia Mainnet (chain ID 8217)', async () => {
      mockRequest
        .mockResolvedValueOnce('0x2019') // 8217 in hex
        .mockResolvedValueOnce('0xf4240') // block 1000000

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('8217')
      expect(info.name).toBe('Kaia Mainnet')
      expect(info.symbol).toBe('KLAY')
      expect(info.decimals).toBe(18)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(1000000)
    })

    it('should identify Kaia Kairos Testnet (chain ID 1001)', async () => {
      mockRequest
        .mockResolvedValueOnce('0x3e9') // 1001 in hex
        .mockResolvedValueOnce('0x1')

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('1001')
      expect(info.name).toBe('Kaia Kairos Testnet')
      expect(info.testnet).toBe(true)
    })
  })

  describe('callContract', () => {
    it('should call with function signature', async () => {
      mockRequest.mockResolvedValueOnce('0x0000000000000000000000000000000000000000000000000de0b6b3a7640000')

      const result = await provider.callContract(
        '0xcontract',
        'balanceOf(address)',
        ['0x1234567890abcdef1234567890abcdef12345678'],
      )

      expect(mockRequest).toHaveBeenCalledWith('klay_call', [
        expect.objectContaining({ to: '0xcontract' }),
        'latest',
      ])
    })

    it('should call with pre-encoded calldata', async () => {
      mockRequest.mockResolvedValueOnce('0x00')

      await provider.callContract('0xcontract', '0x70a08231abcdef')

      expect(mockRequest).toHaveBeenCalledWith('klay_call', [
        { to: '0xcontract', data: '0x70a08231abcdef' },
        'latest',
      ])
    })
  })

  describe('estimateGas', () => {
    it('should estimate gas using klay_estimateGas', async () => {
      mockRequest.mockResolvedValueOnce('0x5208') // 21000

      const gas = await provider.estimateGas('0xcontract', 'transfer(address,uint256)', [
        '0x1234567890abcdef1234567890abcdef12345678',
        1000n,
      ])

      expect(mockRequest).toHaveBeenCalledWith('klay_estimateGas', [
        expect.objectContaining({ to: '0xcontract' }),
      ])
      expect(gas).toBe('21000')
    })
  })

  describe('getTokenBalance', () => {
    it('should fetch KIP-7 token balance', async () => {
      // Mock balanceOf, decimals, symbol calls
      mockRequest
        .mockResolvedValueOnce('0x0000000000000000000000000000000000000000000000000de0b6b3a7640000') // 1e18
        .mockResolvedValueOnce('0x0000000000000000000000000000000000000000000000000000000000000012') // 18
        .mockResolvedValueOnce(
          '0x' +
            '0000000000000000000000000000000000000000000000000000000000000020' + // offset
            '0000000000000000000000000000000000000000000000000000000000000004' + // length 4
            '4b4c415900000000000000000000000000000000000000000000000000000000', // "KLAY"
        )

      const balance = await provider.getTokenBalance(
        '0xholder',
        '0xtoken',
      )

      expect(balance.amount).toBe('1000000000000000000')
      expect(balance.decimals).toBe(18)
      expect(balance.symbol).toBe('KLAY')
    })
  })

  describe('getTokenMetadata', () => {
    it('should fetch KIP-7 token metadata', async () => {
      const abiEncodedName =
        '0x' +
        '0000000000000000000000000000000000000000000000000000000000000020' +
        '000000000000000000000000000000000000000000000000000000000000000a' +
        '4b616961546f6b656e00000000000000000000000000000000000000000000000' // "KaiaToken" (10 chars but extra 0 is padding)

      const abiEncodedSymbol =
        '0x' +
        '0000000000000000000000000000000000000000000000000000000000000020' +
        '0000000000000000000000000000000000000000000000000000000000000002' +
        '4b540000000000000000000000000000000000000000000000000000000000000' // "KT"

      mockRequest
        .mockResolvedValueOnce(abiEncodedName) // name
        .mockResolvedValueOnce(abiEncodedSymbol) // symbol
        .mockResolvedValueOnce('0x0000000000000000000000000000000000000000000000000000000000000012') // decimals 18
        .mockResolvedValueOnce('0x00000000000000000000000000000000000000000000d3c21bcecceda1000000') // totalSupply

      const metadata = await provider.getTokenMetadata('0xtoken')

      expect(metadata.address).toBe('0xtoken')
      expect(metadata.decimals).toBe(18)
    })
  })

  describe('subscribeBlocks', () => {
    it('should return an unsubscribe function', async () => {
      mockRequest.mockResolvedValue('0x1')

      const unsubscribe = await provider.subscribeBlocks(() => {})

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      mockRequest.mockResolvedValue('0x1')

      const unsubscribe = await provider.subscribeTransactions(
        '0x1234567890abcdef1234567890abcdef12345678',
        () => {},
      )

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })
})
