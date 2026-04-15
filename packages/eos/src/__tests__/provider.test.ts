import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EosProvider } from '../provider.js'

// Mock fetch for all provider tests
const mockFetch = vi.fn()
global.fetch = mockFetch

function mockFetchResponse(data: unknown, ok = true) {
  mockFetch.mockResolvedValueOnce({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: async () => data,
  })
}

describe('EosProvider', () => {
  let provider: EosProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new EosProvider({
      endpoints: ['https://eos.example.com'],
    })
  })

  describe('constructor', () => {
    it('should throw with no endpoints', () => {
      expect(() => new EosProvider({ endpoints: [] })).toThrow(
        'At least one EOSIO endpoint is required',
      )
    })
  })

  describe('getBalance', () => {
    it('should return parsed EOS balance', async () => {
      mockFetchResponse({
        account_name: 'testaccount1',
        core_liquid_balance: '100.5000 EOS',
        ram_quota: 10000,
        ram_usage: 5000,
        net_weight: 1000,
        cpu_weight: 1000,
        net_limit: { used: 0, available: 100, max: 100 },
        cpu_limit: { used: 0, available: 100, max: 100 },
        permissions: [],
        created: '2019-01-01T00:00:00.000',
        head_block_num: 1000,
        head_block_time: '2024-01-01T00:00:00.000',
      })

      const balance = await provider.getBalance('testaccount1')

      expect(balance.address).toBe('testaccount1')
      expect(balance.amount).toBe('1005000')
      expect(balance.symbol).toBe('EOS')
      expect(balance.decimals).toBe(4)
    })

    it('should return zero balance when core_liquid_balance is missing', async () => {
      mockFetchResponse({
        account_name: 'newaccount',
        ram_quota: 0,
        ram_usage: 0,
        net_weight: 0,
        cpu_weight: 0,
        net_limit: { used: 0, available: 0, max: 0 },
        cpu_limit: { used: 0, available: 0, max: 0 },
        permissions: [],
        created: '2024-01-01T00:00:00.000',
        head_block_num: 1000,
        head_block_time: '2024-01-01T00:00:00.000',
      })

      const balance = await provider.getBalance('newaccount')

      expect(balance.amount).toBe('0')
      expect(balance.symbol).toBe('EOS')
      expect(balance.decimals).toBe(4)
    })
  })

  describe('getBlock', () => {
    it('should return block info by number', async () => {
      mockFetchResponse({
        id: 'abc123def456',
        block_num: 100,
        previous: 'prev_block_hash',
        timestamp: '2024-01-01T00:00:00.000',
        producer: 'eosproducer1',
        confirmed: 0,
        transaction_mroot: 'mroot',
        action_mroot: 'amroot',
        transactions: [
          {
            status: 'executed',
            cpu_usage_us: 100,
            net_usage_words: 10,
            trx: { id: 'tx1', signatures: [], packed_trx: '' },
          },
        ],
      })

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('abc123def456')
      expect(block!.parentHash).toBe('prev_block_hash')
      expect(block!.transactions).toEqual(['tx1'])
    })

    it('should return block info by hash/id', async () => {
      mockFetchResponse({
        id: 'abc123def456',
        block_num: 100,
        previous: 'prev_block_hash',
        timestamp: '2024-01-01T00:00:00.000',
        producer: 'eosproducer1',
        confirmed: 0,
        transaction_mroot: 'mroot',
        action_mroot: 'amroot',
        transactions: [],
      })

      const block = await provider.getBlock('abc123def456')

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
    })

    it('should handle string trx ids', async () => {
      mockFetchResponse({
        id: 'block_id',
        block_num: 50,
        previous: 'prev',
        timestamp: '2024-01-01T00:00:00.000',
        producer: 'prod',
        confirmed: 0,
        transaction_mroot: '',
        action_mroot: '',
        transactions: [
          {
            status: 'executed',
            cpu_usage_us: 100,
            net_usage_words: 10,
            trx: 'simple_tx_hash',
          },
        ],
      })

      const block = await provider.getBlock(50)
      expect(block!.transactions).toEqual(['simple_tx_hash'])
    })
  })

  describe('getChainInfo', () => {
    it('should return EOS mainnet info', async () => {
      mockFetchResponse({
        server_version: 'v3.0.0',
        chain_id: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
        head_block_num: 500000000,
        last_irreversible_block_num: 499999990,
        head_block_id: 'head_id',
        head_block_time: '2024-01-01T00:00:00.000',
        head_block_producer: 'eosproducer1',
        virtual_block_cpu_limit: 200000,
        virtual_block_net_limit: 1048576,
        block_cpu_limit: 200000,
        block_net_limit: 1048576,
      })

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906')
      expect(info.name).toBe('EOS Mainnet')
      expect(info.symbol).toBe('EOS')
      expect(info.decimals).toBe(4)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(500000000)
    })

    it('should handle unknown chain IDs', async () => {
      mockFetchResponse({
        server_version: 'v3.0.0',
        chain_id: 'unknown_chain_id',
        head_block_num: 100,
        last_irreversible_block_num: 90,
        head_block_id: 'head',
        head_block_time: '2024-01-01T00:00:00.000',
        head_block_producer: 'prod',
        virtual_block_cpu_limit: 200000,
        virtual_block_net_limit: 1048576,
        block_cpu_limit: 200000,
        block_net_limit: 1048576,
      })

      const info = await provider.getChainInfo()

      expect(info.name).toContain('EOSIO Chain')
    })
  })

  describe('estimateFee', () => {
    it('should return zero-fee estimates (EOS uses staking)', async () => {
      mockFetchResponse({
        server_version: 'v3.0.0',
        chain_id: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
        head_block_num: 100,
        last_irreversible_block_num: 90,
        head_block_id: 'head',
        head_block_time: '2024-01-01T00:00:00.000',
        head_block_producer: 'prod',
        virtual_block_cpu_limit: 200000,
        virtual_block_net_limit: 1048576,
        block_cpu_limit: 200000,
        block_net_limit: 1048576,
      })

      const fee = await provider.estimateFee()

      expect(fee.slow).toBe('0')
      expect(fee.average).toBe('0')
      expect(fee.fast).toBe('0')
      expect(fee.unit).toBe('staked')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast and return transaction ID', async () => {
      mockFetchResponse({
        transaction_id: 'abc123def456',
        processed: {},
      })

      const txId = await provider.broadcastTransaction(
        JSON.stringify({
          signatures: ['SIG_K1_test'],
          compression: 'none',
          packed_trx: 'deadbeef',
          packed_context_free_data: '',
        }),
      )

      expect(txId).toBe('abc123def456')
    })
  })

  describe('callContract (ContractCapable)', () => {
    it('should query a table by name', async () => {
      const mockRows = {
        rows: [{ key: 'value1' }, { key: 'value2' }],
        more: false,
      }
      mockFetchResponse(mockRows)

      const result = await provider.callContract('eosio.token', 'accounts', ['testaccount1'])

      expect(result).toEqual(mockRows)

      // Verify the request was made correctly
      const call = mockFetch.mock.calls[0]
      expect(call[0]).toBe('https://eos.example.com/v1/chain/get_table_rows')
      const body = JSON.parse(call[1].body)
      expect(body.code).toBe('eosio.token')
      expect(body.table).toBe('accounts')
      expect(body.scope).toBe('testaccount1')
    })

    it('should accept JSON method string for full query params', async () => {
      const mockRows = {
        rows: [{ balance: '100.0000 EOS' }],
        more: false,
      }
      mockFetchResponse(mockRows)

      const result = await provider.callContract(
        'eosio.token',
        '{"scope":"testaccount1","table":"accounts","limit":5}',
      )

      expect(result).toEqual(mockRows)
    })
  })

  describe('estimateGas (ContractCapable)', () => {
    it('should return block CPU limit as baseline', async () => {
      mockFetchResponse({
        server_version: 'v3.0.0',
        chain_id: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
        head_block_num: 100,
        last_irreversible_block_num: 90,
        head_block_id: 'head',
        head_block_time: '2024-01-01T00:00:00.000',
        head_block_producer: 'prod',
        virtual_block_cpu_limit: 200000,
        virtual_block_net_limit: 1048576,
        block_cpu_limit: 200000,
        block_net_limit: 1048576,
      })

      const gas = await provider.estimateGas('eosio.token', 'transfer')
      expect(gas).toBe('200000')
    })
  })

  describe('getTokenBalance (TokenCapable)', () => {
    it('should return token balance', async () => {
      mockFetchResponse(['50.0000 EOS'])

      const balance = await provider.getTokenBalance('testaccount1', 'eosio.token')

      expect(balance.address).toBe('testaccount1')
      expect(balance.amount).toBe('500000')
      expect(balance.symbol).toBe('EOS')
      expect(balance.decimals).toBe(4)
    })

    it('should handle empty balance', async () => {
      mockFetchResponse([])

      const balance = await provider.getTokenBalance('emptyaccount', 'eosio.token')

      expect(balance.amount).toBe('0')
      expect(balance.symbol).toBe('UNKNOWN')
    })

    it('should handle custom token decimals', async () => {
      mockFetchResponse(['1234.56 USDT'])

      const balance = await provider.getTokenBalance('testaccount1', 'tethertether')

      expect(balance.amount).toBe('123456')
      expect(balance.symbol).toBe('USDT')
      expect(balance.decimals).toBe(2)
    })
  })

  describe('getTokenMetadata (TokenCapable)', () => {
    it('should return token metadata from stat table', async () => {
      mockFetchResponse({
        rows: [
          {
            supply: '1000000000.0000 EOS',
            max_supply: '10000000000.0000 EOS',
            issuer: 'eosio',
          },
        ],
        more: false,
      })

      const meta = await provider.getTokenMetadata('eosio.token')

      expect(meta.address).toBe('eosio.token')
      expect(meta.symbol).toBe('EOS')
      expect(meta.decimals).toBe(4)
      expect(meta.totalSupply).toBe('10000000000000')
    })

    it('should handle unknown token', async () => {
      mockFetchResponse({ rows: [], more: false })

      const meta = await provider.getTokenMetadata('unknown.token')

      expect(meta.symbol).toBe('UNKNOWN')
      expect(meta.decimals).toBe(4)
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info for transfer', async () => {
      mockFetchResponse({
        id: 'tx123',
        trx: {
          receipt: {
            status: 'executed',
            cpu_usage_us: 150,
            net_usage_words: 12,
          },
          trx: {
            actions: [
              {
                account: 'eosio.token',
                name: 'transfer',
                authorization: [{ actor: 'sender1', permission: 'active' }],
                data: {
                  from: 'sender1',
                  to: 'receiver1',
                  quantity: '10.0000 EOS',
                  memo: 'test transfer',
                },
              },
            ],
          },
        },
        block_num: 500,
        block_time: '2024-01-01T00:00:00.000',
      })

      const tx = await provider.getTransaction('tx123')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('tx123')
      expect(tx!.from).toBe('sender1')
      expect(tx!.to).toBe('receiver1')
      expect(tx!.value).toBe('100000')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(500)
    })

    it('should return null for non-existent transaction', async () => {
      mockFetchResponse(
        { error: { code: 3040011, message: 'Transaction not found' } },
        false,
      )

      const tx = await provider.getTransaction('nonexistent')
      expect(tx).toBeNull()
    })
  })

  describe('subscribeBlocks', () => {
    it('should call callback when new block arrives and support unsubscribe', async () => {
      let callCount = 0
      const blockNumbers: number[] = []

      // First call returns block 100
      mockFetchResponse({
        server_version: 'v3.0.0',
        chain_id: 'test',
        head_block_num: 100,
        last_irreversible_block_num: 90,
        head_block_id: 'head',
        head_block_time: '2024-01-01T00:00:00.000',
        head_block_producer: 'prod',
        virtual_block_cpu_limit: 200000,
        virtual_block_net_limit: 1048576,
        block_cpu_limit: 200000,
        block_net_limit: 1048576,
      })

      const unsubscribe = await provider.subscribeBlocks((blockNum) => {
        blockNumbers.push(blockNum)
        callCount++
      })

      // Wait a bit for the first poll
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(callCount).toBeGreaterThanOrEqual(1)
      expect(blockNumbers[0]).toBe(100)

      // Unsubscribe
      unsubscribe()
    })
  })
})
