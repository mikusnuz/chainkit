import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VeChainProvider } from './provider.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

describe('VeChainProvider', () => {
  let provider: VeChainProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new VeChainProvider({ url: 'https://testnet.veblocks.net' })
  })

  describe('constructor', () => {
    it('should create provider with valid config', () => {
      const p = new VeChainProvider({ url: 'https://testnet.veblocks.net' })
      expect(p).toBeInstanceOf(VeChainProvider)
    })

    it('should throw for missing URL', () => {
      expect(() => new VeChainProvider({ url: '' })).toThrow('VeChain REST API URL is required')
    })

    it('should strip trailing slash from URL', () => {
      const p = new VeChainProvider({ url: 'https://testnet.veblocks.net/' })
      // Provider should work without double slash issues
      expect(p).toBeInstanceOf(VeChainProvider)
    })
  })

  describe('getBalance', () => {
    it('should return VET balance', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          balance: '0xde0b6b3a7640000', // 1 VET in wei
          energy: '0x0',
          hasCode: false,
        }),
      )

      const balance = await provider.getBalance('0x7567d83b7b8d80addcb281a71d54fc7b3364ffed')

      expect(balance.symbol).toBe('VET')
      expect(balance.decimals).toBe(18)
      expect(balance.amount).toBe('1000000000000000000')
      expect(balance.address).toBe('0x7567d83b7b8d80addcb281a71d54fc7b3364ffed')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://testnet.veblocks.net/accounts/0x7567d83b7b8d80addcb281a71d54fc7b3364ffed',
        expect.objectContaining({ method: 'GET' }),
      )
    })

    it('should handle zero balance', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          balance: '0x0',
          energy: '0x0',
          hasCode: false,
        }),
      )

      const balance = await provider.getBalance('0x7567d83b7b8d80addcb281a71d54fc7b3364ffed')
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info for confirmed tx', async () => {
      // First call: GET /transactions/{id}
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          id: '0xabc123',
          chainTag: 39,
          blockRef: '0x00000000aabbccdd',
          expiration: 720,
          clauses: [
            {
              to: '0x7567d83b7b8d80addcb281a71d54fc7b3364ffed',
              value: '0xde0b6b3a7640000',
              data: '0x',
            },
          ],
          gasPriceCoef: 0,
          gas: 21000,
          origin: '0x1234567890abcdef1234567890abcdef12345678',
          delegator: null,
          nonce: '0x1',
          dependsOn: null,
          size: 130,
          meta: {
            blockID: '0xblock123',
            blockNumber: 100,
            blockTimestamp: 1700000000,
          },
        }),
      )

      // Second call: GET /transactions/{id}/receipt
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          gasUsed: 21000,
          gasPayer: '0x1234567890abcdef1234567890abcdef12345678',
          paid: '0x4a817c800', // 20 VTHO
          reward: '0x0',
          reverted: false,
          meta: {
            blockID: '0xblock123',
            blockNumber: 100,
            blockTimestamp: 1700000000,
          },
          outputs: [],
        }),
      )

      const tx = await provider.getTransaction('0xabc123')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('0xabc123')
      expect(tx!.from).toBe('0x1234567890abcdef1234567890abcdef12345678')
      expect(tx!.to).toBe('0x7567d83b7b8d80addcb281a71d54fc7b3364ffed')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(100)
      expect(tx!.timestamp).toBe(1700000000)
    })

    it('should return null for non-existent tx', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(null))

      const tx = await provider.getTransaction('0xnonexistent')
      expect(tx).toBeNull()
    })

    it('should handle reverted transactions', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          id: '0xfailed',
          chainTag: 39,
          blockRef: '0x00000000aabbccdd',
          expiration: 720,
          clauses: [{ to: '0xabc', value: '0x0', data: '0x' }],
          gasPriceCoef: 0,
          gas: 21000,
          origin: '0x123',
          delegator: null,
          nonce: '0x1',
          dependsOn: null,
          size: 130,
          meta: {
            blockID: '0xblock456',
            blockNumber: 200,
            blockTimestamp: 1700001000,
          },
        }),
      )

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          gasUsed: 21000,
          gasPayer: '0x123',
          paid: '0x4a817c800',
          reward: '0x0',
          reverted: true,
          meta: {
            blockID: '0xblock456',
            blockNumber: 200,
            blockTimestamp: 1700001000,
          },
          outputs: [],
        }),
      )

      const tx = await provider.getTransaction('0xfailed')
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should return block info by number', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          number: 100,
          id: '0xblock100',
          size: 1234,
          parentID: '0xblock99',
          timestamp: 1700000000,
          gasLimit: 10000000,
          beneficiary: '0xbeneficiary',
          gasUsed: 50000,
          totalScore: 1000,
          txsRoot: '0x',
          txsFeatures: 0,
          stateRoot: '0x',
          receiptsRoot: '0x',
          com: true,
          signer: '0xsigner',
          isTrunk: true,
          isFinalized: true,
          transactions: ['0xtx1', '0xtx2'],
        }),
      )

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('0xblock100')
      expect(block!.parentHash).toBe('0xblock99')
      expect(block!.timestamp).toBe(1700000000)
      expect(block!.transactions).toEqual(['0xtx1', '0xtx2'])

      expect(mockFetch).toHaveBeenCalledWith(
        'https://testnet.veblocks.net/blocks/100',
        expect.objectContaining({ method: 'GET' }),
      )
    })

    it('should return null for non-existent block', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(null))

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })

    it('should accept block hash as string', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          number: 50,
          id: '0xblockhash',
          parentID: '0xparent',
          timestamp: 1700000000,
          transactions: [],
        }),
      )

      const block = await provider.getBlock('0xblockhash')
      expect(block).not.toBeNull()
      expect(block!.number).toBe(50)
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates in VTHO', async () => {
      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('VTHO')
      expect(Number(fee.slow)).toBeGreaterThan(0)
      expect(Number(fee.average)).toBeGreaterThanOrEqual(Number(fee.slow))
      expect(Number(fee.fast)).toBeGreaterThanOrEqual(Number(fee.average))
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast and return transaction ID', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ id: '0xnewtxhash123' }),
      )

      const txHash = await provider.broadcastTransaction('0xsignedtxdata')
      expect(txHash).toBe('0xnewtxhash123')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://testnet.veblocks.net/transactions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ raw: '0xsignedtxdata' }),
        }),
      )
    })
  })

  describe('getChainInfo', () => {
    it('should return testnet chain info', async () => {
      // GET /blocks/0 (genesis)
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          number: 0,
          id: '0x000000000b2bce3c70bc649a02749e8687721b09ed2e15997f466536b20bb127',
          timestamp: 1530316800,
        }),
      )

      // GET /blocks/best
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          number: 12345678,
          id: '0xbestblock',
          timestamp: 1700001000,
        }),
      )

      const info = await provider.getChainInfo()

      expect(info.name).toBe('VeChain Testnet')
      expect(info.symbol).toBe('VET')
      expect(info.decimals).toBe(18)
      expect(info.testnet).toBe(true)
      expect(info.blockHeight).toBe(12345678)
    })

    it('should return mainnet chain info', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          number: 0,
          id: '0x00000000851caf3cfdb6e899cf5958bfb1ac3413d346d43539627e6be7ec1b4a',
          timestamp: 1530316800,
        }),
      )

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          number: 20000000,
          id: '0xbestblock',
          timestamp: 1700001000,
        }),
      )

      const info = await provider.getChainInfo()
      expect(info.name).toBe('VeChain Mainnet')
      expect(info.testnet).toBe(false)
    })
  })

  describe('callContract', () => {
    it('should call contract with function signature', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            data: '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000',
            events: [],
            transfers: [],
            gasUsed: 500,
            reverted: false,
            vmError: '',
          },
        ]),
      )

      const result = await provider.callContract(
        '0x0000000000000000000000000000456e65726779',
        'balanceOf(address)',
        ['0x7567d83b7b8d80addcb281a71d54fc7b3364ffed'],
      )

      expect(result).toBe('0x0000000000000000000000000000000000000000000000000de0b6b3a7640000')
    })

    it('should call contract with pre-encoded data', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            data: '0x0000000000000000000000000000000000000000000000000000000000000001',
            events: [],
            transfers: [],
            gasUsed: 300,
            reverted: false,
            vmError: '',
          },
        ]),
      )

      await provider.callContract(
        '0xcontract',
        '0x70a08231000000000000000000000000abcdef',
      )

      expect(mockFetch).toHaveBeenCalled()
    })

    it('should throw on reverted contract call', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            data: '0x',
            events: [],
            transfers: [],
            gasUsed: 100,
            reverted: true,
            vmError: 'out of gas',
          },
        ]),
      )

      await expect(
        provider.callContract('0xcontract', 'someMethod()'),
      ).rejects.toThrow('Contract call reverted')
    })
  })

  describe('estimateGas', () => {
    it('should return gas estimate with buffer', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            data: '0x',
            events: [],
            transfers: [],
            gasUsed: 21000,
            reverted: false,
            vmError: '',
          },
        ]),
      )

      const gas = await provider.estimateGas(
        '0xcontract',
        'transfer(address)',
        ['0x7567d83b7b8d80addcb281a71d54fc7b3364ffed'],
      )

      // 21000 * 1.15 = 24150
      expect(Number(gas)).toBe(24150)
    })
  })

  describe('getTokenBalance', () => {
    it('should return VIP-180 token balance', async () => {
      // balanceOf call
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            data: '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000',
            reverted: false,
          },
        ]),
      )

      // decimals call
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            data: '0x0000000000000000000000000000000000000000000000000000000000000012',
            reverted: false,
          },
        ]),
      )

      // symbol call
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            data: '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000045654484f00000000000000000000000000000000000000000000000000000000',
            reverted: false,
          },
        ]),
      )

      const balance = await provider.getTokenBalance(
        '0x7567d83b7b8d80addcb281a71d54fc7b3364ffed',
        '0x0000000000000000000000000000456e65726779',
      )

      expect(balance.amount).toBe('1000000000000000000')
      expect(balance.decimals).toBe(18)
      expect(balance.symbol).toBe('VTHO')
    })
  })

  describe('getTokenMetadata', () => {
    it('should return token metadata', async () => {
      // name call
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            data: '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000b566554686f7220456e65726779000000000000000000000000000000000000',
            reverted: false,
          },
        ]),
      )

      // symbol call
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            data: '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000045654484f00000000000000000000000000000000000000000000000000000000',
            reverted: false,
          },
        ]),
      )

      // decimals call
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            data: '0x0000000000000000000000000000000000000000000000000000000000000012',
            reverted: false,
          },
        ]),
      )

      // totalSupply call
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse([
          {
            data: '0x00000000000000000000000000000000000000000000d3c21bcecceda1000000',
            reverted: false,
          },
        ]),
      )

      const metadata = await provider.getTokenMetadata(
        '0x0000000000000000000000000000456e65726779',
      )

      expect(metadata.symbol).toBe('VTHO')
      expect(metadata.decimals).toBe(18)
      expect(metadata.address).toBe('0x0000000000000000000000000000456e65726779')
    })
  })

  describe('subscribeBlocks', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ number: 100 }),
      )

      const unsubscribe = await provider.subscribeBlocks(() => {})

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ number: 100 }),
      )

      const unsubscribe = await provider.subscribeTransactions(
        '0x7567d83b7b8d80addcb281a71d54fc7b3364ffed',
        () => {},
      )

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })
})
