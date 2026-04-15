import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BitcoinProvider } from '../provider.js'

function createMockResponse(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
  } as unknown as Response
}

describe('BitcoinProvider', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let provider: BitcoinProvider

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    provider = new BitcoinProvider({ endpoints: ['http://rpc.test'] })
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
    it('should sum all UTXOs and return balance in satoshis', async () => {
      // scantxoutset
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          unspents: [
            { txid: 'tx1', vout: 0, amount: 0.5, scriptPubKey: 'script1', height: 100 },
            { txid: 'tx2', vout: 1, amount: 0.3, scriptPubKey: 'script2', height: 200 },
          ],
        }),
      )

      const balance = await provider.getBalance('bc1qtest')

      expect(getMethodFromCall(0)).toBe('scantxoutset')
      expect(balance).toEqual({
        address: 'bc1qtest',
        amount: '80000000', // 0.5 + 0.3 = 0.8 BTC = 80000000 sat
        symbol: 'BTC',
        decimals: 8,
      })
    })

    it('should handle zero balance (no UTXOs)', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          unspents: [],
        }),
      )

      const balance = await provider.getBalance('bc1qempty')
      expect(balance.amount).toBe('0')
    })
  })

  describe('getUtxos', () => {
    it('should return UTXO list from scantxoutset', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          unspents: [
            { txid: 'txhash1', vout: 0, amount: 1.0, scriptPubKey: 'abcd', height: 800000 },
            { txid: 'txhash2', vout: 2, amount: 0.001, scriptPubKey: 'ef01', height: 0 },
          ],
        }),
      )

      const utxos = await provider.getUtxos('bc1qtest')

      expect(getMethodFromCall(0)).toBe('scantxoutset')
      expect(getParamsFromCall(0)).toEqual(['start', ['addr(bc1qtest)']])
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
        createMockResponse({
          unspents: [
            { txid: 'tx1', vout: 0, amount: 0.1, scriptPubKey: 's1', height: 100 },
            { txid: 'tx2', vout: 0, amount: 0.5, scriptPubKey: 's2', height: 200 },
            { txid: 'tx3', vout: 0, amount: 0.2, scriptPubKey: 's3', height: 300 },
          ],
        }),
      )

      const result = await provider.selectUtxos('bc1qtest', '40000000') // 0.4 BTC

      // Should select the largest first (0.5 BTC = 50000000 sat), which covers 40000000
      expect(result.utxos).toHaveLength(1)
      expect(result.utxos[0].amount).toBe('50000000')
      expect(result.change).toBe('10000000') // 50000000 - 40000000
    })

    it('should throw on insufficient balance', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          unspents: [
            { txid: 'tx1', vout: 0, amount: 0.01, scriptPubKey: 's1', height: 100 },
          ],
        }),
      )

      await expect(provider.selectUtxos('bc1qtest', '100000000')).rejects.toThrow(
        'Insufficient funds',
      )
    })
  })

  describe('getTransaction', () => {
    it('should return null for non-existent transaction', async () => {
      // Create an RPC error response for non-existent tx
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -5, message: 'No such mempool or blockchain transaction' },
          }),
      } as unknown as Response)

      const tx = await provider.getTransaction('0xdeadbeef')
      expect(tx).toBeNull()
    })

    it('should return transaction info for confirmed tx', async () => {
      // getrawtransaction
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          txid: 'abc123',
          blockhash: 'blockhash456',
          vin: [{ address: 'bc1qsender' }],
          vout: [
            {
              value: 0.5,
              n: 0,
              scriptPubKey: { address: 'bc1qrecipient' },
            },
          ],
          fee: -0.0001,
        }),
      )

      // getblock (for block height & timestamp)
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          height: 800000,
          time: 1700000000,
        }),
      )

      const tx = await provider.getTransaction('abc123')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('abc123')
      expect(tx!.from).toBe('bc1qsender')
      expect(tx!.to).toBe('bc1qrecipient')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(800000)
      expect(tx!.blockHash).toBe('blockhash456')
      expect(tx!.timestamp).toBe(1700000000)
      expect(tx!.value).toBe('50000000')
      expect(tx!.fee).toBe('10000')

      expect(getMethodFromCall(0)).toBe('getrawtransaction')
      expect(getMethodFromCall(1)).toBe('getblock')
    })

    it('should return pending status for unconfirmed tx', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          txid: 'pending123',
          vin: [{ address: 'bc1qsender' }],
          vout: [
            {
              value: 0.1,
              n: 0,
              scriptPubKey: { address: 'bc1qrecipient' },
            },
          ],
        }),
      )

      const tx = await provider.getTransaction('pending123')
      expect(tx!.status).toBe('pending')
      expect(tx!.blockNumber).toBeNull()
    })
  })

  describe('getBlock', () => {
    it('should fetch block by height', async () => {
      // getblockhash
      mockFetch.mockResolvedValueOnce(createMockResponse('blockhash800000'))
      // getblock
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          height: 800000,
          hash: 'blockhash800000',
          previousblockhash: 'parenthash799999',
          time: 1700000000,
          tx: ['tx1', 'tx2', 'tx3'],
        }),
      )

      const block = await provider.getBlock(800000)

      expect(getMethodFromCall(0)).toBe('getblockhash')
      expect(getParamsFromCall(0)).toEqual([800000])
      expect(getMethodFromCall(1)).toBe('getblock')
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
          height: 100,
          hash: blockHash,
          previousblockhash: 'parent',
          time: 1600000000,
          tx: [],
        }),
      )

      const block = await provider.getBlock(blockHash)
      expect(getMethodFromCall(0)).toBe('getblock')
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
            error: { code: -8, message: 'Block height out of range' },
          }),
      } as unknown as Response)

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates in sat/vB', async () => {
      // estimatesmartfee with 6 blocks
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ feerate: 0.00005 }), // 5 sat/vB
      )
      // estimatesmartfee with 3 blocks
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ feerate: 0.0001 }), // 10 sat/vB
      )
      // estimatesmartfee with 1 block
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ feerate: 0.0002 }), // 20 sat/vB
      )

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('sat/vB')
      expect(parseFloat(fee.slow)).toBeCloseTo(5.0, 0)
      expect(parseFloat(fee.average)).toBeCloseTo(10.0, 0)
      expect(parseFloat(fee.fast)).toBeCloseTo(20.0, 0)
    })
  })

  describe('broadcastTransaction', () => {
    it('should call sendrawtransaction', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('txhash123'))

      const txHash = await provider.broadcastTransaction('0xsignedtxhex')

      expect(getMethodFromCall(0)).toBe('sendrawtransaction')
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
          chain: 'main',
          blocks: 800000,
        }),
      )

      const info = await provider.getChainInfo()

      expect(getMethodFromCall(0)).toBe('getblockchaininfo')
      expect(info).toEqual({
        chainId: 'main',
        name: 'Bitcoin Mainnet',
        symbol: 'BTC',
        decimals: 8,
        testnet: false,
        blockHeight: 800000,
      })
    })

    it('should return chain info for testnet', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          chain: 'test',
          blocks: 2500000,
        }),
      )

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Bitcoin Testnet')
      expect(info.testnet).toBe(true)
    })

    it('should handle signet', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          chain: 'signet',
          blocks: 150000,
        }),
      )

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Bitcoin Signet')
      expect(info.testnet).toBe(true)
    })

    it('should handle regtest', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          chain: 'regtest',
          blocks: 100,
        }),
      )

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Bitcoin Regtest')
      expect(info.testnet).toBe(true)
    })
  })

  describe('subscribeBlocks', () => {
    it('should call the callback when a new block is detected', async () => {
      mockFetch.mockImplementation(() => {
        return Promise.resolve(
          createMockResponse({
            blocks: 800001,
          }),
        )
      })

      const callback = vi.fn()
      const unsubscribe = await provider.subscribeBlocks(callback)

      // Wait a bit for the first poll
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(callback).toHaveBeenCalledWith(800001)

      // Unsubscribe to clean up
      unsubscribe()
    })
  })

  describe('subscribeTransactions', () => {
    it('should set up polling and return an unsubscribe function', async () => {
      // Initial getblockchaininfo call
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          blocks: 800000,
        }),
      )

      const callback = vi.fn()
      const unsubscribe = await provider.subscribeTransactions(
        'bc1qtest',
        callback,
      )

      expect(typeof unsubscribe).toBe('function')

      // Clean up
      unsubscribe()
    })
  })
})
