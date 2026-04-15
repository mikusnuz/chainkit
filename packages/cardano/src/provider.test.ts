import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CardanoProvider } from './provider.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

const config = {
  baseUrl: 'https://cardano-mainnet.blockfrost.io/api/v0',
  projectId: 'test-project-id',
}

describe('CardanoProvider', () => {
  let provider: CardanoProvider

  beforeEach(() => {
    provider = new CardanoProvider(config)
    mockFetch.mockReset()
  })

  describe('constructor', () => {
    it('should throw if baseUrl is missing', () => {
      expect(
        () => new CardanoProvider({ baseUrl: '', projectId: 'test' }),
      ).toThrow('base URL is required')
    })

    it('should throw if projectId is missing', () => {
      expect(
        () => new CardanoProvider({ baseUrl: 'https://example.com', projectId: '' }),
      ).toThrow('project ID is required')
    })
  })

  describe('getBalance', () => {
    it('should return balance from UTXO sum', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse([
          {
            tx_hash: 'abc123',
            tx_index: 0,
            output_index: 0,
            amount: [{ unit: 'lovelace', quantity: '5000000' }],
            block: 'block1',
          },
          {
            tx_hash: 'def456',
            tx_index: 1,
            output_index: 1,
            amount: [{ unit: 'lovelace', quantity: '3000000' }],
            block: 'block2',
          },
        ]),
      )

      const balance = await provider.getBalance('addr1_test')

      expect(balance.amount).toBe('8000000')
      expect(balance.symbol).toBe('ADA')
      expect(balance.decimals).toBe(6)
    })

    it('should return zero balance for address with no UTXOs', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, 404))

      const balance = await provider.getBalance('addr1_empty')

      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info', async () => {
      // First call: /txs/{hash}
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          hash: 'tx_hash_123',
          fees: '180000',
          block_height: 12345,
          block: 'block_hash_abc',
          slot: 50000000,
          valid_contract: true,
        }),
      )

      // Second call: /txs/{hash}/utxos
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          inputs: [{ address: 'addr1_sender' }],
          outputs: [
            {
              address: 'addr1_recipient',
              amount: [{ unit: 'lovelace', quantity: '2000000' }],
            },
          ],
        }),
      )

      const tx = await provider.getTransaction('tx_hash_123')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('tx_hash_123')
      expect(tx!.from).toBe('addr1_sender')
      expect(tx!.to).toBe('addr1_recipient')
      expect(tx!.value).toBe('2000000')
      expect(tx!.fee).toBe('180000')
      expect(tx!.status).toBe('confirmed')
    })

    it('should return null for non-existent transaction', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, 404))

      const tx = await provider.getTransaction('non_existent')

      expect(tx).toBeNull()
    })
  })

  describe('getBlock', () => {
    it('should return block info', async () => {
      // Block info
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          height: 100,
          hash: 'block_hash',
          previous_block: 'prev_hash',
          time: 1700000000,
          tx_count: 2,
        }),
      )

      // Block transactions
      mockFetch.mockResolvedValueOnce(
        mockResponse(['tx1', 'tx2']),
      )

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('block_hash')
      expect(block!.parentHash).toBe('prev_hash')
      expect(block!.transactions).toEqual(['tx1', 'tx2'])
    })

    it('should return null for non-existent block', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, 404))

      const block = await provider.getBlock(999999999)

      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates from epoch parameters', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          min_fee_a: 44,
          min_fee_b: 155381,
        }),
      )

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('lovelace')
      expect(Number(fee.slow)).toBe(44 * 200 + 155381) // 164181
      expect(Number(fee.average)).toBe(44 * 400 + 155381) // 172981
      expect(Number(fee.fast)).toBe(44 * 800 + 155381) // 190581
    })

    it('should return default fees on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('lovelace')
      expect(fee.slow).toBe('170000')
    })
  })

  describe('getChainInfo', () => {
    it('should return mainnet info', async () => {
      // Genesis
      mockFetch.mockResolvedValueOnce(
        mockResponse({ network_magic: 764824073 }),
      )
      // Latest block
      mockFetch.mockResolvedValueOnce(
        mockResponse({ height: 12345 }),
      )

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Cardano Mainnet')
      expect(info.symbol).toBe('ADA')
      expect(info.decimals).toBe(6)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(12345)
    })

    it('should return testnet info', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ network_magic: 1 }),
      )
      mockFetch.mockResolvedValueOnce(
        mockResponse({ height: 100 }),
      )

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Cardano Testnet')
      expect(info.testnet).toBe(true)
    })
  })

  describe('getUtxos', () => {
    it('should return parsed UTXOs', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse([
          {
            tx_hash: 'hash1',
            tx_index: 0,
            output_index: 0,
            amount: [
              { unit: 'lovelace', quantity: '5000000' },
              { unit: 'policy123asset456', quantity: '100' },
            ],
            block: 'block1',
          },
        ]),
      )

      const utxos = await provider.getUtxos('addr1_test')

      expect(utxos).toHaveLength(1)
      expect(utxos[0].txHash).toBe('hash1')
      expect(utxos[0].outputIndex).toBe(0)
      expect(utxos[0].amount).toBe('5000000')
      expect(utxos[0].confirmed).toBe(true)
    })

    it('should return empty array for address with no UTXOs', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, 404))

      const utxos = await provider.getUtxos('addr1_empty')

      expect(utxos).toEqual([])
    })
  })

  describe('selectUtxos', () => {
    it('should select UTXOs to cover the target amount', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse([
          {
            tx_hash: 'hash1',
            tx_index: 0,
            output_index: 0,
            amount: [{ unit: 'lovelace', quantity: '3000000' }],
            block: 'block1',
          },
          {
            tx_hash: 'hash2',
            tx_index: 1,
            output_index: 1,
            amount: [{ unit: 'lovelace', quantity: '5000000' }],
            block: 'block2',
          },
        ]),
      )

      const result = await provider.selectUtxos('addr1_test', '4000000')

      // Should pick the 5M UTXO first (largest first)
      expect(result.utxos).toHaveLength(1)
      expect(result.utxos[0].amount).toBe('5000000')
      expect(result.change).toBe('1000000')
    })

    it('should throw when insufficient UTXOs', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse([
          {
            tx_hash: 'hash1',
            tx_index: 0,
            output_index: 0,
            amount: [{ unit: 'lovelace', quantity: '1000000' }],
            block: 'block1',
          },
        ]),
      )

      await expect(
        provider.selectUtxos('addr1_test', '5000000'),
      ).rejects.toThrow('Insufficient UTXOs')
    })
  })

  describe('getTokenBalance', () => {
    it('should return token balance from UTXOs', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse([
          {
            amount: [
              { unit: 'lovelace', quantity: '2000000' },
              { unit: 'policy123asset456', quantity: '500' },
            ],
          },
          {
            amount: [
              { unit: 'lovelace', quantity: '2000000' },
              { unit: 'policy123asset456', quantity: '300' },
            ],
          },
        ]),
      )

      const balance = await provider.getTokenBalance('addr1_test', 'policy123asset456')

      expect(balance.amount).toBe('800')
    })

    it('should return zero for missing token', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, 404))

      const balance = await provider.getTokenBalance('addr1_test', 'nonexistent')

      expect(balance.amount).toBe('0')
    })
  })

  describe('getTokenMetadata', () => {
    it('should return token metadata', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          asset_name: 'TestToken',
          quantity: '1000000',
          onchain_metadata: {
            name: 'Test Token',
            ticker: 'TT',
          },
          metadata: {
            decimals: 6,
          },
        }),
      )

      const meta = await provider.getTokenMetadata('policy123asset456')

      expect(meta.name).toBe('Test Token')
      expect(meta.symbol).toBe('TT')
      expect(meta.decimals).toBe(6)
      expect(meta.totalSupply).toBe('1000000')
    })

    it('should throw for non-existent asset', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, 404))

      await expect(provider.getTokenMetadata('nonexistent')).rejects.toThrow(
        'Asset not found',
      )
    })
  })

  describe('callContract', () => {
    it('should query datum by hash', async () => {
      const datumData = { constructor: 0, fields: [] }
      mockFetch.mockResolvedValueOnce(mockResponse(datumData))

      const result = await provider.callContract('addr1_script', 'datum', ['datum_hash_123'])

      expect(result).toEqual(datumData)
    })

    it('should throw when datum hash is missing', async () => {
      await expect(
        provider.callContract('addr1_script', 'datum'),
      ).rejects.toThrow('Datum hash is required')
    })

    it('should query script info by default', async () => {
      const scriptInfo = { type: 'plutusV2', hash: 'script_hash' }
      mockFetch.mockResolvedValueOnce(mockResponse(scriptInfo))

      const result = await provider.callContract('script_hash', 'info')

      expect(result).toEqual(scriptInfo)
    })
  })

  describe('broadcastTransaction', () => {
    it('should submit CBOR-encoded transaction', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('tx_hash_result'))

      const result = await provider.broadcastTransaction('0xdeadbeef')

      expect(result).toBe('tx_hash_result')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/tx/submit'),
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  describe('subscribeBlocks', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(mockResponse({ height: 100 }))

      const unsubscribe = await provider.subscribeBlocks(() => {})

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(mockResponse(null, 404))

      const unsubscribe = await provider.subscribeTransactions('addr1_test', () => {})

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })
})
