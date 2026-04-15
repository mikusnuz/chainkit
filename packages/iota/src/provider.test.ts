import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IotaProvider } from './provider.js'

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

const TEST_ADDRESS = 'iota1qpg2xkw68tljkc2lsn05lk35rr55dun0qg0ufyzr2letwfj5k34sq4exlz'
const BASE_URL = 'https://api.testnet.shimmer.network'

describe('IotaProvider', () => {
  let provider: IotaProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new IotaProvider({ baseUrl: BASE_URL })
  })

  describe('constructor', () => {
    it('should create provider with valid config', () => {
      const p = new IotaProvider({ baseUrl: BASE_URL })
      expect(p).toBeInstanceOf(IotaProvider)
    })

    it('should reject empty base URL', () => {
      expect(() => new IotaProvider({ baseUrl: '' })).toThrow('base URL is required')
    })

    it('should strip trailing slash from base URL', () => {
      const p = new IotaProvider({ baseUrl: BASE_URL + '/' })
      expect(p).toBeInstanceOf(IotaProvider)
    })
  })

  describe('getBalance', () => {
    it('should return balance by summing unspent outputs', async () => {
      // First call: indexer query for output IDs
      mockFetch
        .mockResolvedValueOnce(
          mockJsonResponse({
            ledgerIndex: 100,
            items: ['output1', 'output2'],
          }),
        )
        // Second call: first output detail
        .mockResolvedValueOnce(
          mockJsonResponse({
            metadata: {
              blockId: 'block1',
              transactionId: 'tx1',
              outputIndex: 0,
              isSpent: false,
              milestoneIndexBooked: 50,
              milestoneTimestampBooked: 1700000000,
              ledgerIndex: 100,
            },
            output: {
              type: 3,
              amount: '1000000',
              unlockConditions: [],
            },
          }),
        )
        // Third call: second output detail
        .mockResolvedValueOnce(
          mockJsonResponse({
            metadata: {
              blockId: 'block2',
              transactionId: 'tx2',
              outputIndex: 0,
              isSpent: false,
              milestoneIndexBooked: 60,
              milestoneTimestampBooked: 1700001000,
              ledgerIndex: 100,
            },
            output: {
              type: 3,
              amount: '2000000',
              unlockConditions: [],
            },
          }),
        )

      const balance = await provider.getBalance(TEST_ADDRESS)
      expect(balance.amount).toBe('3000000')
      expect(balance.symbol).toBe('IOTA')
      expect(balance.decimals).toBe(6)
      expect(balance.address).toBe(TEST_ADDRESS)
    })

    it('should skip spent outputs', async () => {
      mockFetch
        .mockResolvedValueOnce(
          mockJsonResponse({
            ledgerIndex: 100,
            items: ['output1', 'output2'],
          }),
        )
        .mockResolvedValueOnce(
          mockJsonResponse({
            metadata: { isSpent: true, blockId: '', transactionId: '', outputIndex: 0, milestoneIndexBooked: 0, milestoneTimestampBooked: 0, ledgerIndex: 0 },
            output: { type: 3, amount: '1000000', unlockConditions: [] },
          }),
        )
        .mockResolvedValueOnce(
          mockJsonResponse({
            metadata: { isSpent: false, blockId: '', transactionId: '', outputIndex: 0, milestoneIndexBooked: 0, milestoneTimestampBooked: 0, ledgerIndex: 0 },
            output: { type: 3, amount: '500000', unlockConditions: [] },
          }),
        )

      const balance = await provider.getBalance(TEST_ADDRESS)
      expect(balance.amount).toBe('500000')
    })

    it('should return zero balance when no outputs', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          ledgerIndex: 100,
          items: [],
        }),
      )

      const balance = await provider.getBalance(TEST_ADDRESS)
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info for a valid block with transaction payload', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          protocolVersion: 2,
          parents: ['parent1'],
          payload: {
            type: 6,
            essence: {
              type: 1,
              networkId: '1234',
              inputs: [
                { type: 0, transactionId: 'inputTx1', transactionOutputIndex: 0 },
              ],
              outputs: [
                { type: 3, amount: '1000000', unlockConditions: [] },
                { type: 3, amount: '500000', unlockConditions: [] },
              ],
            },
          },
          nonce: '0',
        }),
      )

      const tx = await provider.getTransaction('blockId123')
      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('blockId123')
      expect(tx!.value).toBe('1500000')
      expect(tx!.fee).toBe('0')
      expect(tx!.status).toBe('confirmed')
    })

    it('should return null for non-transaction blocks', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          protocolVersion: 2,
          parents: ['parent1'],
          payload: { type: 7 },
          nonce: '0',
        }),
      )

      const tx = await provider.getTransaction('blockId456')
      expect(tx).toBeNull()
    })

    it('should return null for blocks without payload', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          protocolVersion: 2,
          parents: ['parent1'],
          nonce: '0',
        }),
      )

      const tx = await provider.getTransaction('blockId789')
      expect(tx).toBeNull()
    })
  })

  describe('getBlock', () => {
    it('should get milestone by index', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          index: 42,
          milestoneId: 'milestone42',
          timestamp: 1700000000,
          previousMilestoneId: 'milestone41',
        }),
      )

      const block = await provider.getBlock(42)
      expect(block).not.toBeNull()
      expect(block!.number).toBe(42)
      expect(block!.hash).toBe('milestone42')
      expect(block!.parentHash).toBe('milestone41')
      expect(block!.timestamp).toBe(1700000000)
    })

    it('should get block by hash', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          protocolVersion: 2,
          parents: ['parent1', 'parent2'],
          nonce: '0',
        }),
      )

      const block = await provider.getBlock('someBlockHash')
      expect(block).not.toBeNull()
      expect(block!.hash).toBe('someBlockHash')
      expect(block!.parentHash).toBe('parent1')
    })
  })

  describe('estimateFee', () => {
    it('should return zero fees (IOTA is feeless)', async () => {
      const fee = await provider.estimateFee()
      expect(fee.slow).toBe('0')
      expect(fee.average).toBe('0')
      expect(fee.fast).toBe('0')
      expect(fee.unit).toBe('micro')
    })
  })

  describe('getChainInfo', () => {
    it('should return chain info from node', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          name: 'HORNET',
          version: '2.0.0',
          status: {
            isHealthy: true,
            latestMilestone: { index: 1000, timestamp: 1700000000, milestoneId: 'ms1000' },
            confirmedMilestone: { index: 999, timestamp: 1699999000, milestoneId: 'ms999' },
          },
          protocol: {
            version: 2,
            networkName: 'testnet',
            bech32Hrp: 'rms',
            minPowScore: 1500,
            belowMaxDepth: 15,
            rentStructure: { vByteCost: 500, vByteFactorKey: 10, vByteFactorData: 1 },
            tokenSupply: '2779530283277761',
          },
          baseToken: {
            name: 'Shimmer',
            tickerSymbol: 'SMR',
            unit: 'SMR',
            subunit: 'glow',
            decimals: 6,
          },
        }),
      )

      const info = await provider.getChainInfo()
      expect(info.chainId).toBe('testnet')
      expect(info.name).toBe('HORNET')
      expect(info.symbol).toBe('SMR')
      expect(info.decimals).toBe(6)
      expect(info.testnet).toBe(true)
      expect(info.blockHeight).toBe(1000)
    })

    it('should detect mainnet correctly', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          name: 'HORNET',
          version: '2.0.0',
          status: {
            isHealthy: true,
            latestMilestone: { index: 5000, timestamp: 1700000000, milestoneId: 'ms5000' },
            confirmedMilestone: { index: 4999, timestamp: 1699999000, milestoneId: 'ms4999' },
          },
          protocol: {
            version: 2,
            networkName: 'iota-mainnet',
            bech32Hrp: 'iota',
            minPowScore: 1500,
            belowMaxDepth: 15,
            rentStructure: { vByteCost: 500, vByteFactorKey: 10, vByteFactorData: 1 },
            tokenSupply: '2779530283277761',
          },
          baseToken: {
            name: 'IOTA',
            tickerSymbol: 'IOTA',
            unit: 'IOTA',
            subunit: 'micro',
            decimals: 6,
          },
        }),
      )

      const info = await provider.getChainInfo()
      expect(info.testnet).toBe(false)
    })
  })

  describe('getTokenBalance', () => {
    it('should sum native token balances from outputs', async () => {
      const tokenId = 'token123'
      mockFetch
        .mockResolvedValueOnce(
          mockJsonResponse({
            ledgerIndex: 100,
            items: ['out1'],
          }),
        )
        .mockResolvedValueOnce(
          mockJsonResponse({
            metadata: { isSpent: false, blockId: '', transactionId: '', outputIndex: 0, milestoneIndexBooked: 0, milestoneTimestampBooked: 0, ledgerIndex: 0 },
            output: {
              type: 3,
              amount: '1000000',
              nativeTokens: [
                { id: tokenId, amount: '500' },
                { id: 'otherToken', amount: '100' },
              ],
              unlockConditions: [],
            },
          }),
        )

      const balance = await provider.getTokenBalance(TEST_ADDRESS, tokenId)
      expect(balance.amount).toBe('500')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a JSON-serialized block', async () => {
      const blockPayload = {
        protocolVersion: 2,
        parents: ['parent1'],
        payload: { type: 6 },
        nonce: '0',
      }

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ blockId: 'newBlockId123' }),
      )

      const txHash = await provider.broadcastTransaction(
        JSON.stringify(blockPayload),
      )
      expect(txHash).toBe('newBlockId123')
    })
  })

  describe('subscribeBlocks', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          name: 'HORNET',
          version: '2.0.0',
          status: {
            isHealthy: true,
            latestMilestone: { index: 100, timestamp: 1700000000, milestoneId: 'ms100' },
            confirmedMilestone: { index: 99, timestamp: 1699999000, milestoneId: 'ms99' },
          },
          protocol: { version: 2, networkName: 'testnet', bech32Hrp: 'rms', minPowScore: 0, belowMaxDepth: 0, rentStructure: { vByteCost: 0, vByteFactorKey: 0, vByteFactorData: 0 }, tokenSupply: '0' },
          baseToken: { name: 'SMR', tickerSymbol: 'SMR', unit: 'SMR', subunit: 'glow', decimals: 6 },
        }),
      )

      const unsub = await provider.subscribeBlocks(() => {})
      expect(typeof unsub).toBe('function')
      unsub() // Clean up
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          ledgerIndex: 100,
          items: [],
        }),
      )

      const unsub = await provider.subscribeTransactions(TEST_ADDRESS, () => {})
      expect(typeof unsub).toBe('function')
      unsub() // Clean up
    })
  })
})
