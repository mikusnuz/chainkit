import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AptosProvider } from '../provider.js'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

const MOCK_BASE_URL = 'https://fullnode.mainnet.aptoslabs.com'
const TEST_ADDRESS = '0x' + '1'.padStart(64, '0')
const TEST_TX_HASH = '0x' + 'ab'.repeat(32)

describe('AptosProvider', () => {
  let provider: AptosProvider

  beforeEach(() => {
    provider = new AptosProvider({ baseUrl: MOCK_BASE_URL })
    mockFetch.mockReset()
  })

  function mockResponse(data: unknown, status = 200) {
    mockFetch.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    })
  }

  describe('getBalance', () => {
    it('should return APT balance via view function (Fungible Asset model)', async () => {
      // View function response returns an array
      mockResponse(['100000000'])

      const balance = await provider.getBalance(TEST_ADDRESS)
      expect(balance.amount).toBe('100000000')
      expect(balance.decimals).toBe(8)
      expect(balance.symbol).toBe('APT')
      expect(balance.address).toBe(TEST_ADDRESS)

      // Verify it called the view endpoint
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/view'),
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('should fallback to CoinStore when view function fails', async () => {
      // First call: view function fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('function not found'),
      })

      // Second call: CoinStore resource succeeds
      mockResponse({
        type: '0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>',
        data: {
          coin: { value: '100000000' },
        },
      })

      const balance = await provider.getBalance(TEST_ADDRESS)
      expect(balance.amount).toBe('100000000')
      expect(balance.decimals).toBe(8)
      expect(balance.symbol).toBe('APT')
    })

    it('should return 0 balance when both methods fail with 404', async () => {
      // First call: view function fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('function not found'),
      })

      // Second call: CoinStore resource not found
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('404 Not Found'),
      })

      const balance = await provider.getBalance(TEST_ADDRESS)
      expect(balance.amount).toBe('0')
      expect(balance.decimals).toBe(8)
      expect(balance.symbol).toBe('APT')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info for a transfer', async () => {
      mockResponse({
        hash: TEST_TX_HASH,
        sender: TEST_ADDRESS,
        sequence_number: '0',
        max_gas_amount: '2000',
        gas_unit_price: '100',
        gas_used: '500',
        success: true,
        version: '12345',
        timestamp: '1700000000000000', // microseconds
        payload: {
          function: '0x1::aptos_account::transfer',
          arguments: ['0x' + '2'.padStart(64, '0'), '50000000'],
        },
        type: 'user_transaction',
      })

      const tx = await provider.getTransaction(TEST_TX_HASH)
      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe(TEST_TX_HASH)
      expect(tx!.from).toBe(TEST_ADDRESS)
      expect(tx!.to).toBe('0x' + '2'.padStart(64, '0'))
      expect(tx!.value).toBe('50000000')
      expect(tx!.fee).toBe('50000') // 500 * 100
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(12345)
      expect(tx!.timestamp).toBe(1700000000) // converted from microseconds
      expect(tx!.nonce).toBe(0)
    })

    it('should return null for non-existent transaction', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('404 Not Found'),
      })

      const tx = await provider.getTransaction(TEST_TX_HASH)
      expect(tx).toBeNull()
    })

    it('should handle failed transactions', async () => {
      mockResponse({
        hash: TEST_TX_HASH,
        sender: TEST_ADDRESS,
        sequence_number: '1',
        max_gas_amount: '2000',
        gas_unit_price: '100',
        gas_used: '1000',
        success: false,
        version: '12346',
        timestamp: '1700000001000000',
        type: 'user_transaction',
      })

      const tx = await provider.getTransaction(TEST_TX_HASH)
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should return block info by height', async () => {
      mockResponse({
        block_height: '100',
        block_hash: '0x' + 'cc'.repeat(32),
        block_timestamp: '1700000000000000',
        first_version: '500',
        last_version: '510',
        transactions: [
          { hash: '0x' + 'aa'.repeat(32) },
          { hash: '0x' + 'bb'.repeat(32) },
        ],
      })

      const block = await provider.getBlock(100)
      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('0x' + 'cc'.repeat(32))
      expect(block!.timestamp).toBe(1700000000)
      expect(block!.transactions).toHaveLength(2)
    })

    it('should return null for non-existent block', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('404 Not Found'),
      })

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates in octa units', async () => {
      mockResponse({
        gas_estimate: 100,
        deprioritized_gas_estimate: 50,
        prioritized_gas_estimate: 200,
      })

      const fee = await provider.estimateFee()
      expect(fee.slow).toBe('50')
      expect(fee.average).toBe('100')
      expect(fee.fast).toBe('200')
      expect(fee.unit).toBe('octa')
    })

    it('should use gas_estimate as fallback for missing priorities', async () => {
      mockResponse({
        gas_estimate: 100,
      })

      const fee = await provider.estimateFee()
      expect(fee.slow).toBe('100')
      expect(fee.average).toBe('100')
      expect(fee.fast).toBe('100')
    })
  })

  describe('getChainInfo', () => {
    it('should return mainnet info', async () => {
      mockResponse({
        chain_id: 1,
        epoch: '100',
        ledger_version: '500000',
        oldest_ledger_version: '0',
        ledger_timestamp: '1700000000000000',
        node_role: 'full_node',
      })

      const info = await provider.getChainInfo()
      expect(info.chainId).toBe('1')
      expect(info.name).toBe('Aptos Mainnet')
      expect(info.symbol).toBe('APT')
      expect(info.decimals).toBe(8)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(500000)
    })

    it('should return testnet info', async () => {
      mockResponse({
        chain_id: 2,
        epoch: '50',
        ledger_version: '100000',
        oldest_ledger_version: '0',
        ledger_timestamp: '1700000000000000',
        node_role: 'full_node',
      })

      const info = await provider.getChainInfo()
      expect(info.chainId).toBe('2')
      expect(info.name).toBe('Aptos Testnet')
      expect(info.testnet).toBe(true)
    })
  })

  describe('callContract (view function)', () => {
    it('should call a Move view function', async () => {
      mockResponse(['100000000'])

      const result = await provider.callContract(
        '0x1',
        '0x1::coin::balance',
        [['0x1::aptos_coin::AptosCoin'], [TEST_ADDRESS]],
      )

      expect(result).toEqual(['100000000'])
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/view'),
        expect.objectContaining({
          method: 'POST',
        }),
      )
    })
  })

  describe('estimateGas', () => {
    it('should return gas unit price', async () => {
      mockResponse({ gas_estimate: 150 })

      const gas = await provider.estimateGas('0x1', '0x1::coin::transfer', [])
      expect(gas).toBe('150')
    })
  })

  describe('getTokenBalance', () => {
    it('should return token balance', async () => {
      // First call: CoinStore resource
      mockResponse({
        type: '0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>',
        data: {
          coin: { value: '500000000' },
        },
      })
      // Second call: CoinInfo resource
      mockResponse({
        data: {
          symbol: 'APT',
          decimals: 8,
        },
      })

      const balance = await provider.getTokenBalance(
        TEST_ADDRESS,
        '0x1::aptos_coin::AptosCoin',
      )
      expect(balance.amount).toBe('500000000')
      expect(balance.symbol).toBe('APT')
      expect(balance.decimals).toBe(8)
    })

    it('should return 0 balance when token not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('404 Not Found'),
      })

      const balance = await provider.getTokenBalance(
        TEST_ADDRESS,
        '0x1::some_coin::SomeCoin',
      )
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTokenMetadata', () => {
    it('should return token metadata', async () => {
      mockResponse({
        data: {
          name: 'Aptos Coin',
          symbol: 'APT',
          decimals: 8,
          supply: {
            vec: [{ integer: { vec: [{ value: '1000000000000000000' }] } }],
          },
        },
      })

      const metadata = await provider.getTokenMetadata('0x1::aptos_coin::AptosCoin')
      expect(metadata.name).toBe('Aptos Coin')
      expect(metadata.symbol).toBe('APT')
      expect(metadata.decimals).toBe(8)
      expect(metadata.totalSupply).toBe('1000000000000000000')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast and return tx hash', async () => {
      mockResponse({ hash: TEST_TX_HASH })

      const hash = await provider.broadcastTransaction('0xdeadbeef')
      expect(hash).toBe(TEST_TX_HASH)
    })
  })
})
