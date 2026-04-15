import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { KaspaProvider } from '../provider.js'

function createMockResponse(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
  } as unknown as Response
}

describe('KaspaProvider', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let provider: KaspaProvider

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    provider = new KaspaProvider({ endpoints: ['http://rpc.test'] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function getMethodFromCall(callIndex: number): string {
    const [, options] = mockFetch.mock.calls[callIndex]
    const body = JSON.parse(options.body)
    return body.method
  }

  function getParamsFromCall(callIndex: number): unknown[] {
    const [, options] = mockFetch.mock.calls[callIndex]
    const body = JSON.parse(options.body)
    return body.params
  }

  describe('getBalance', () => {
    it('should sum all UTXOs and return balance in sompi', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([
          {
            outpoint: { transactionId: 'tx1', index: 0 },
            utxoEntry: { amount: '50000000', scriptPublicKey: { script: 's1' }, blockDaaScore: 100 },
          },
          {
            outpoint: { transactionId: 'tx2', index: 1 },
            utxoEntry: { amount: '30000000', scriptPublicKey: { script: 's2' }, blockDaaScore: 200 },
          },
        ]),
      )

      const balance = await provider.getBalance('kaspa1qtest')

      expect(getMethodFromCall(0)).toBe('getUtxosByAddress')
      expect(balance).toEqual({
        address: 'kaspa1qtest',
        amount: '80000000',
        symbol: 'KAS',
        decimals: 8,
      })
    })

    it('should handle zero balance (no UTXOs)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]))

      const balance = await provider.getBalance('kaspa1qempty')
      expect(balance.amount).toBe('0')
    })
  })

  describe('getUtxos', () => {
    it('should return UTXO list from getUtxosByAddress', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([
          {
            outpoint: { transactionId: 'txhash1', index: 0 },
            utxoEntry: { amount: '100000000', scriptPublicKey: { script: 'abcd' }, blockDaaScore: 800000 },
          },
          {
            outpoint: { transactionId: 'txhash2', index: 2 },
            utxoEntry: { amount: '100000', scriptPublicKey: { script: 'ef01' }, blockDaaScore: 0 },
          },
        ]),
      )

      const utxos = await provider.getUtxos('kaspa1qtest')

      expect(getMethodFromCall(0)).toBe('getUtxosByAddress')
      expect(getParamsFromCall(0)).toEqual(['kaspa1qtest'])
      expect(utxos).toHaveLength(2)
      expect(utxos[0]).toEqual({
        txHash: 'txhash1',
        outputIndex: 0,
        amount: '100000000',
        script: 'abcd',
        confirmed: true,
      })
      expect(utxos[1]).toEqual({
        txHash: 'txhash2',
        outputIndex: 2,
        amount: '100000',
        script: 'ef01',
        confirmed: false,
      })
    })
  })

  describe('selectUtxos', () => {
    it('should select UTXOs to cover the target amount', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([
          {
            outpoint: { transactionId: 'tx1', index: 0 },
            utxoEntry: { amount: '10000000', scriptPublicKey: { script: 's1' }, blockDaaScore: 100 },
          },
          {
            outpoint: { transactionId: 'tx2', index: 0 },
            utxoEntry: { amount: '50000000', scriptPublicKey: { script: 's2' }, blockDaaScore: 200 },
          },
          {
            outpoint: { transactionId: 'tx3', index: 0 },
            utxoEntry: { amount: '20000000', scriptPublicKey: { script: 's3' }, blockDaaScore: 300 },
          },
        ]),
      )

      const result = await provider.selectUtxos('kaspa1qtest', '40000000')

      // Should select the largest first (50000000), which covers 40000000
      expect(result.utxos).toHaveLength(1)
      expect(result.utxos[0].amount).toBe('50000000')
      expect(result.change).toBe('10000000')
    })

    it('should throw on insufficient balance', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([
          {
            outpoint: { transactionId: 'tx1', index: 0 },
            utxoEntry: { amount: '1000000', scriptPublicKey: { script: 's1' }, blockDaaScore: 100 },
          },
        ]),
      )

      await expect(provider.selectUtxos('kaspa1qtest', '100000000')).rejects.toThrow(
        'Insufficient funds',
      )
    })
  })

  describe('getTransaction', () => {
    it('should return null for non-existent transaction', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -5, message: 'Transaction not found' },
          }),
      } as unknown as Response)

      const tx = await provider.getTransaction('0xdeadbeef')
      expect(tx).toBeNull()
    })

    it('should return transaction info for confirmed tx', async () => {
      // getTransaction
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          transactionId: 'abc123',
          blockHash: 'blockhash456',
          inputs: [{ previousOutpoint: { address: 'kaspa1qsender' } }],
          outputs: [
            { amount: '50000000', scriptPublicKey: { address: 'kaspa1qrecipient' } },
          ],
          fee: '1000',
        }),
      )

      // getBlock (for block height & timestamp)
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          header: {
            blueScore: 800000,
            timestamp: 1700000000,
          },
        }),
      )

      const tx = await provider.getTransaction('abc123')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('abc123')
      expect(tx!.from).toBe('kaspa1qsender')
      expect(tx!.to).toBe('kaspa1qrecipient')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(800000)
      expect(tx!.blockHash).toBe('blockhash456')
      expect(tx!.timestamp).toBe(1700000000)
      expect(tx!.value).toBe('50000000')
      expect(tx!.fee).toBe('1000')

      expect(getMethodFromCall(0)).toBe('getTransaction')
      expect(getMethodFromCall(1)).toBe('getBlock')
    })

    it('should return pending status for unconfirmed tx', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          transactionId: 'pending123',
          inputs: [{ previousOutpoint: { address: 'kaspa1qsender' } }],
          outputs: [
            { amount: '10000000', scriptPublicKey: { address: 'kaspa1qrecipient' } },
          ],
          fee: '500',
        }),
      )

      const tx = await provider.getTransaction('pending123')
      expect(tx!.status).toBe('pending')
      expect(tx!.blockNumber).toBeNull()
    })
  })

  describe('getBlock', () => {
    it('should fetch block by DAA score', async () => {
      // getBlockByDaaScore
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ hash: 'blockhash800000' }),
      )
      // getBlock
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          hash: 'blockhash800000',
          header: {
            blueScore: 800000,
            parentHashes: ['parenthash799999'],
            timestamp: 1700000000,
          },
          transactions: [
            { transactionId: 'tx1' },
            { transactionId: 'tx2' },
            { transactionId: 'tx3' },
          ],
        }),
      )

      const block = await provider.getBlock(800000)

      expect(getMethodFromCall(0)).toBe('getBlockByDaaScore')
      expect(getParamsFromCall(0)).toEqual([800000])
      expect(getMethodFromCall(1)).toBe('getBlock')
      expect(block).not.toBeNull()
      expect(block!.number).toBe(800000)
      expect(block!.hash).toBe('blockhash800000')
      expect(block!.parentHash).toBe('parenthash799999')
      expect(block!.timestamp).toBe(1700000000)
      expect(block!.transactions).toEqual(['tx1', 'tx2', 'tx3'])
    })

    it('should fetch block by hash', async () => {
      const blockHash = 'a'.repeat(64)
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          hash: blockHash,
          header: {
            blueScore: 100,
            parentHashes: ['parent'],
            timestamp: 1600000000,
          },
          transactions: [],
        }),
      )

      const block = await provider.getBlock(blockHash)
      expect(getMethodFromCall(0)).toBe('getBlock')
      expect(getParamsFromCall(0)).toEqual([blockHash])
      expect(block!.number).toBe(100)
    })

    it('should return null for non-existent block', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -8, message: 'Block not found' },
          }),
      } as unknown as Response)

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates in sompi/gram', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          priorityBucket: { feerate: '2000' },
          normalBuckets: [
            { feerate: '1000' },
            { feerate: '500' },
          ],
        }),
      )

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('sompi/gram')
      expect(fee.fast).toBe('2000')
      expect(fee.average).toBe('1000')
      expect(fee.slow).toBe('500')
    })

    it('should return fallback fees on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('RPC error'))

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('sompi/gram')
      expect(fee.slow).toBe('100')
      expect(fee.average).toBe('500')
      expect(fee.fast).toBe('1000')
    })
  })

  describe('broadcastTransaction', () => {
    it('should call submitTransaction', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('txhash123'))

      const txHash = await provider.broadcastTransaction('0xsignedtxhex')

      expect(getMethodFromCall(0)).toBe('submitTransaction')
      expect(getParamsFromCall(0)).toEqual(['signedtxhex'])
      expect(txHash).toBe('txhash123')
    })

    it('should strip 0x prefix before sending', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('txhash456'))

      await provider.broadcastTransaction('0xabcdef')

      expect(getParamsFromCall(0)).toEqual(['abcdef'])
    })
  })

  describe('getChainInfo', () => {
    it('should return chain info for mainnet', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          networkName: 'kaspa-mainnet',
          virtualDaaScore: 50000000,
        }),
      )

      const info = await provider.getChainInfo()

      expect(getMethodFromCall(0)).toBe('getBlockDagInfo')
      expect(info).toEqual({
        chainId: 'kaspa-mainnet',
        name: 'Kaspa Mainnet',
        symbol: 'KAS',
        decimals: 8,
        testnet: false,
        blockHeight: 50000000,
      })
    })

    it('should return chain info for testnet', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          networkName: 'kaspa-testnet',
          virtualDaaScore: 2500000,
        }),
      )

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Kaspa Testnet')
      expect(info.testnet).toBe(true)
    })

    it('should handle devnet', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          networkName: 'kaspa-devnet',
          virtualDaaScore: 150000,
        }),
      )

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Kaspa Devnet')
      expect(info.testnet).toBe(true)
    })

    it('should handle simnet', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          networkName: 'kaspa-simnet',
          virtualDaaScore: 100,
        }),
      )

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Kaspa Simnet')
      expect(info.testnet).toBe(true)
    })
  })

  describe('subscribeBlocks', () => {
    it('should call the callback when a new DAG block is detected', async () => {
      mockFetch.mockImplementation(() => {
        return Promise.resolve(
          createMockResponse({
            virtualDaaScore: 50000001,
          }),
        )
      })

      const callback = vi.fn()
      const unsubscribe = await provider.subscribeBlocks(callback)

      // Wait a bit for the first poll
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(callback).toHaveBeenCalledWith(50000001)

      unsubscribe()
    })
  })

  describe('subscribeTransactions', () => {
    it('should set up polling and return an unsubscribe function', async () => {
      // Initial getUtxosByAddress call
      mockFetch.mockResolvedValueOnce(createMockResponse([]))

      const callback = vi.fn()
      const unsubscribe = await provider.subscribeTransactions(
        'kaspa1qtest',
        callback,
      )

      expect(typeof unsubscribe).toBe('function')

      unsubscribe()
    })
  })
})
