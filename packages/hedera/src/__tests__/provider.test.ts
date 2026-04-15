import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HederaProvider } from '../provider.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

describe('HederaProvider', () => {
  let provider: HederaProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new HederaProvider({
      baseUrl: 'https://testnet.mirrornode.hedera.com',
    })
  })

  describe('constructor', () => {
    it('should strip trailing slashes from baseUrl', () => {
      const p = new HederaProvider({
        baseUrl: 'https://testnet.mirrornode.hedera.com///',
      })
      // Indirectly test by making a request
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ account: '0.0.12345', balance: { balance: 100000000, timestamp: '1234567890.000000000' } }),
      )
      p.getBalance('0.0.12345')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.12345'),
        expect.any(Object),
      )
    })
  })

  describe('getBalance', () => {
    it('should return the HBAR balance for an account', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          account: '0.0.12345',
          balance: { balance: 500000000, timestamp: '1234567890.000000000' },
        }),
      )

      const balance = await provider.getBalance('0.0.12345')

      expect(balance).toEqual({
        address: '0.0.12345',
        amount: '500000000',
        symbol: 'HBAR',
        decimals: 8,
      })
    })

    it('should call the correct Mirror Node endpoint', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          account: '0.0.12345',
          balance: { balance: 0, timestamp: '0' },
        }),
      )

      await provider.getBalance('0.0.12345')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.12345',
        expect.objectContaining({
          method: 'GET',
          headers: { Accept: 'application/json' },
        }),
      )
    })
  })

  describe('getTransaction', () => {
    it('should return transaction details', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          transactions: [
            {
              transaction_id: '0.0.12345-1234567890-123456789',
              consensus_timestamp: '1234567890.123456789',
              charged_tx_fee: 50000,
              max_fee: '100000',
              result: 'SUCCESS',
              name: 'CRYPTOTRANSFER',
              node: '0.0.3',
              transfers: [
                { account: '0.0.12345', amount: -100050000 },
                { account: '0.0.67890', amount: 100000000 },
                { account: '0.0.3', amount: 50000 },
              ],
              valid_start_timestamp: '1234567890.000000000',
              memo_base64: '',
              transaction_hash: 'abc123',
              nonce: 0,
            },
          ],
        }),
      )

      const tx = await provider.getTransaction('0.0.12345-1234567890-123456789')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('0.0.12345-1234567890-123456789')
      expect(tx!.from).toBe('0.0.12345')
      expect(tx!.to).toBe('0.0.67890')
      expect(tx!.value).toBe('100000000')
      expect(tx!.fee).toBe('50000')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.timestamp).toBe(1234567890)
    })

    it('should return null for missing transactions', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          transactions: [],
        }),
      )

      const tx = await provider.getTransaction('nonexistent')
      expect(tx).toBeNull()
    })

    it('should mark failed transactions correctly', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          transactions: [
            {
              transaction_id: '0.0.12345-1234567890-123456789',
              consensus_timestamp: '1234567890.123456789',
              charged_tx_fee: 50000,
              max_fee: '100000',
              result: 'INSUFFICIENT_ACCOUNT_BALANCE',
              name: 'CRYPTOTRANSFER',
              node: '0.0.3',
              transfers: [
                { account: '0.0.12345', amount: -50000 },
                { account: '0.0.3', amount: 50000 },
              ],
              valid_start_timestamp: '1234567890.000000000',
              memo_base64: '',
              transaction_hash: 'abc123',
              nonce: 0,
            },
          ],
        }),
      )

      const tx = await provider.getTransaction('0.0.12345-1234567890-123456789')
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should return block details by number', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          number: 100,
          hash: '0xabcdef1234567890',
          previous_hash: '0x1234567890abcdef',
          timestamp: { from: '1234567890.000000000', to: '1234567892.000000000' },
          count: 5,
        }),
      )

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('0xabcdef1234567890')
      expect(block!.parentHash).toBe('0x1234567890abcdef')
      expect(block!.timestamp).toBe(1234567890)
    })

    it('should return null for non-existent blocks', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ message: 'Not found' }, false, 404),
      )

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates from network fees', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          fees: [
            { gas: 10000, transaction_type: 'CryptoTransfer' },
            { gas: 50000, transaction_type: 'ContractCall' },
            { gas: 100000, transaction_type: 'ContractCreate' },
          ],
        }),
      )

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('tinybar')
      expect(Number(fee.slow)).toBeLessThanOrEqual(Number(fee.average))
      expect(Number(fee.average)).toBeLessThanOrEqual(Number(fee.fast))
    })

    it('should return default fees when network fees endpoint fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const fee = await provider.estimateFee()

      expect(fee).toEqual({
        slow: '10000',
        average: '50000',
        fast: '100000',
        unit: 'tinybar',
      })
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a signed transaction', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          transactionId: '0.0.12345-1234567890-123456789',
        }),
      )

      const txId = await provider.broadcastTransaction('0xdeadbeef')
      expect(txId).toBe('0.0.12345-1234567890-123456789')
    })
  })

  describe('getChainInfo', () => {
    it('should return testnet info for testnet URL', async () => {
      mockFetch
        .mockResolvedValueOnce(mockFetchResponse({ unreachable_nodes: [] }))
        .mockResolvedValueOnce(
          mockFetchResponse({ blocks: [{ number: 12345 }] }),
        )

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Hedera Testnet')
      expect(info.symbol).toBe('HBAR')
      expect(info.decimals).toBe(8)
      expect(info.testnet).toBe(true)
      expect(info.chainId).toBe('hedera')
      expect(info.blockHeight).toBe(12345)
    })

    it('should return mainnet info for mainnet URL', async () => {
      const mainnetProvider = new HederaProvider({
        baseUrl: 'https://mainnet-public.mirrornode.hedera.com',
      })

      mockFetch
        .mockResolvedValueOnce(mockFetchResponse({ unreachable_nodes: [] }))
        .mockResolvedValueOnce(
          mockFetchResponse({ blocks: [{ number: 99999 }] }),
        )

      const info = await mainnetProvider.getChainInfo()

      expect(info.name).toBe('Hedera Mainnet')
      expect(info.testnet).toBe(false)
    })
  })

  describe('callContract', () => {
    it('should call a smart contract method', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ result: '0x0000000000000000000000000000000000000001' }),
      )

      const result = await provider.callContract('0.0.12345', '0x70a08231')

      expect(result).toBe('0x0000000000000000000000000000000000000001')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://testnet.mirrornode.hedera.com/api/v1/contracts/call',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            data: '0x70a08231',
            to: '0.0.12345',
            estimate: false,
          }),
        }),
      )
    })
  })

  describe('estimateGas', () => {
    it('should estimate gas for a contract call', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ result: '0x5208' }),
      )

      const gas = await provider.estimateGas('0.0.12345', '0x70a08231')
      expect(gas).toBe('21000')
    })
  })

  describe('getTokenBalance', () => {
    it('should return token balance for an account', async () => {
      mockFetch
        .mockResolvedValueOnce(
          mockFetchResponse({
            tokens: [{ token_id: '0.0.67890', balance: 1000000, decimals: 6 }],
          }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ symbol: 'USDC' }),
        )

      const balance = await provider.getTokenBalance('0.0.12345', '0.0.67890')

      expect(balance.amount).toBe('1000000')
      expect(balance.symbol).toBe('USDC')
      expect(balance.decimals).toBe(6)
    })

    it('should return zero balance when token not found', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({ tokens: [] }),
      )

      const balance = await provider.getTokenBalance('0.0.12345', '0.0.99999')
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTokenMetadata', () => {
    it('should return token metadata', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchResponse({
          token_id: '0.0.67890',
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: '6',
          total_supply: '1000000000000',
          type: 'FUNGIBLE_COMMON',
        }),
      )

      const metadata = await provider.getTokenMetadata('0.0.67890')

      expect(metadata.address).toBe('0.0.67890')
      expect(metadata.name).toBe('USD Coin')
      expect(metadata.symbol).toBe('USDC')
      expect(metadata.decimals).toBe(6)
      expect(metadata.totalSupply).toBe('1000000000000')
    })
  })

  describe('subscribeBlocks', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(
        mockFetchResponse({ blocks: [{ number: 100 }] }),
      )

      const unsub = await provider.subscribeBlocks(() => {})
      expect(typeof unsub).toBe('function')
      unsub()
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(
        mockFetchResponse({ transactions: [] }),
      )

      const unsub = await provider.subscribeTransactions('0.0.12345', () => {})
      expect(typeof unsub).toBe('function')
      unsub()
    })
  })
})
