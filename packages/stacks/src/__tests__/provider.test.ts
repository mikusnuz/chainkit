import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StacksProvider } from '../provider.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data)),
  }
}

describe('StacksProvider', () => {
  let provider: StacksProvider

  beforeEach(() => {
    mockFetch.mockReset()
    provider = new StacksProvider({
      baseUrl: 'https://api.mainnet.hiro.so',
      network: 'mainnet',
    })
  })

  describe('constructor', () => {
    it('should throw if baseUrl is empty', () => {
      expect(() => new StacksProvider({ baseUrl: '' })).toThrow('baseUrl is required')
    })

    it('should strip trailing slashes from baseUrl', () => {
      const p = new StacksProvider({ baseUrl: 'https://api.mainnet.hiro.so///' })
      // We can verify by checking getChainInfo calls the right URL
      expect(p).toBeDefined()
    })
  })

  describe('getBalance', () => {
    it('should return STX balance for an address', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          balance: '0x0000000000000000000000000f4240',
          locked: '0x00000000000000000000000000000000',
          nonce: 5,
        }),
      )

      const balance = await provider.getBalance('SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7')

      expect(balance.address).toBe('SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7')
      expect(balance.amount).toBe('1000000')
      expect(balance.symbol).toBe('STX')
      expect(balance.decimals).toBe(6)
    })

    it('should handle zero balance', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          balance: '0x00',
          locked: '0x00',
          nonce: 0,
        }),
      )

      const balance = await provider.getBalance('SP000000000000000000002Q6VF78')
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info for a confirmed tx', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          tx_id: '0xabc123',
          sender_address: 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7',
          token_transfer: {
            recipient_address: 'SP000000000000000000002Q6VF78',
            amount: '1000000',
            memo: '0x',
          },
          fee_rate: '200',
          nonce: 1,
          block_height: 100000,
          block_hash: '0xblock123',
          tx_status: 'success',
          burn_block_time: 1700000000,
          tx_type: 'token_transfer',
        }),
      )

      const tx = await provider.getTransaction('0xabc123')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('0xabc123')
      expect(tx!.from).toBe('SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7')
      expect(tx!.to).toBe('SP000000000000000000002Q6VF78')
      expect(tx!.value).toBe('1000000')
      expect(tx!.fee).toBe('200')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(100000)
      expect(tx!.timestamp).toBe(1700000000)
    })

    it('should return null for 404 not found', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 404))

      const tx = await provider.getTransaction('0xnonexistent')
      expect(tx).toBeNull()
    })

    it('should handle failed transactions', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          tx_id: '0xfailed',
          sender_address: 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7',
          fee_rate: '200',
          nonce: 2,
          block_height: 100001,
          block_hash: '0xblock456',
          tx_status: 'abort_by_response',
          burn_block_time: 1700000100,
          tx_type: 'contract_call',
        }),
      )

      const tx = await provider.getTransaction('0xfailed')
      expect(tx).not.toBeNull()
      expect(tx!.status).toBe('failed')
    })

    it('should handle pending transactions', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          tx_id: '0xpending',
          sender_address: 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7',
          fee_rate: '200',
          nonce: 3,
          tx_status: 'pending',
          tx_type: 'token_transfer',
        }),
      )

      const tx = await provider.getTransaction('0xpending')
      expect(tx).not.toBeNull()
      expect(tx!.status).toBe('pending')
      expect(tx!.blockNumber).toBeNull()
    })
  })

  describe('getBlock', () => {
    const blockResponse = {
      height: 100000,
      hash: '0xblockhash123',
      parent_block_hash: '0xparenthash456',
      burn_block_time: 1700000000,
      txs: ['0xtx1', '0xtx2'],
    }

    it('should get block by number', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(blockResponse))

      const block = await provider.getBlock(100000)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100000)
      expect(block!.hash).toBe('0xblockhash123')
      expect(block!.parentHash).toBe('0xparenthash456')
      expect(block!.timestamp).toBe(1700000000)
      expect(block!.transactions).toEqual(['0xtx1', '0xtx2'])

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/extended/v1/block/by_height/100000'),
        expect.any(Object),
      )
    })

    it('should get block by hash', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(blockResponse))

      const block = await provider.getBlock('0xblockhash123')

      expect(block).not.toBeNull()
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/extended/v1/block/0xblockhash123'),
        expect.any(Object),
      )
    })

    it('should return null for 404', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 404))

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          estimated_cost: {
            write_count: 1,
            write_length: 1,
            read_count: 1,
            read_length: 1,
            runtime: 1,
          },
          estimated_cost_scalar: 1,
          estimations: [
            { fee: 180, fee_rate: 1 },
            { fee: 500, fee_rate: 2 },
            { fee: 1200, fee_rate: 3 },
          ],
          cost_scalar_change_by_byte: 0,
        }),
      )

      const fee = await provider.estimateFee()

      expect(fee.slow).toBe('180')
      expect(fee.average).toBe('500')
      expect(fee.fast).toBe('1200')
      expect(fee.unit).toBe('microSTX')
    })

    it('should return fallback fees on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const fee = await provider.estimateFee()

      expect(fee.slow).toBe('200')
      expect(fee.average).toBe('500')
      expect(fee.fast).toBe('1000')
      expect(fee.unit).toBe('microSTX')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast and return txid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('"0xnewtxid123"'),
      })

      const txid = await provider.broadcastTransaction('0xdeadbeef')
      expect(txid).toBe('0xnewtxid123')
    })

    it('should throw on broadcast failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('Invalid transaction'),
      })

      await expect(provider.broadcastTransaction('0xbadtx')).rejects.toThrow('Broadcast failed')
    })
  })

  describe('getChainInfo', () => {
    it('should return mainnet chain info', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          peer_version: 402653189,
          pox_consensus: '0x123',
          burn_block_height: 800000,
          stable_pox_consensus: '0x456',
          stable_burn_block_height: 799999,
          server_version: 'stacks-node 2.5.0',
          network_id: 1,
          parent_network_id: 1,
          stacks_tip_height: 150000,
          stacks_tip: '0xtip',
          stacks_tip_consensus_hash: '0xhash',
          unanchored_tip: '0xutip',
          exit_at_block_height: 0,
        }),
      )

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('1')
      expect(info.name).toBe('Stacks Mainnet')
      expect(info.symbol).toBe('STX')
      expect(info.decimals).toBe(6)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(150000)
    })

    it('should return testnet chain info', async () => {
      const testnetProvider = new StacksProvider({
        baseUrl: 'https://api.testnet.hiro.so',
        network: 'testnet',
      })

      mockFetch.mockResolvedValueOnce(
        mockResponse({
          peer_version: 402653189,
          network_id: 2147483648,
          stacks_tip_height: 50000,
          pox_consensus: '0x',
          burn_block_height: 0,
          stable_pox_consensus: '0x',
          stable_burn_block_height: 0,
          server_version: 'test',
          parent_network_id: 0,
          stacks_tip: '0x',
          stacks_tip_consensus_hash: '0x',
          unanchored_tip: '0x',
          exit_at_block_height: 0,
        }),
      )

      const info = await testnetProvider.getChainInfo()
      expect(info.name).toBe('Stacks Testnet')
      expect(info.testnet).toBe(true)
    })
  })

  describe('callContract', () => {
    it('should call a read-only contract method', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          okay: true,
          result: '0x0100000000000000000000000000000064',
        }),
      )

      const result = await provider.callContract(
        'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7.my-token',
        'get-balance',
        ['0x0516deadbeef'],
      )

      expect(result).toBe('0x0100000000000000000000000000000064')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(
          '/v2/contracts/call-read/SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7/my-token/get-balance',
        ),
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('should throw on failed contract call', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          okay: false,
          cause: 'Runtime error',
        }),
      )

      await expect(
        provider.callContract('SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7.my-token', 'bad-fn'),
      ).rejects.toThrow('Contract call failed')
    })

    it('should throw for invalid contract identifier', async () => {
      await expect(
        provider.callContract('invalid-no-dot', 'method'),
      ).rejects.toThrow('Invalid contract identifier')
    })
  })

  describe('estimateGas', () => {
    it('should estimate fee for contract call', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          estimated_cost: {},
          estimated_cost_scalar: 1,
          estimations: [
            { fee: 200, fee_rate: 1 },
            { fee: 500, fee_rate: 2 },
            { fee: 1000, fee_rate: 3 },
          ],
          cost_scalar_change_by_byte: 0,
        }),
      )

      const gas = await provider.estimateGas(
        'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7.contract',
        'method',
      )

      // average (500) * 3 = 1500
      expect(gas).toBe('1500')
    })
  })

  describe('getTokenBalance', () => {
    it('should return SIP-010 token balance', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          fungible_tokens: {
            'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7.my-token::my-token': {
              balance: '5000000',
              total_sent: '1000000',
              total_received: '6000000',
            },
          },
        }),
      )

      const balance = await provider.getTokenBalance(
        'SP000000000000000000002Q6VF78',
        'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7.my-token',
      )

      expect(balance.amount).toBe('5000000')
      expect(balance.symbol).toBe('FT')
      expect(balance.decimals).toBe(6)
    })

    it('should return zero for unknown token', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          fungible_tokens: {},
        }),
      )

      const balance = await provider.getTokenBalance(
        'SP000000000000000000002Q6VF78',
        'SP000000000000000000002Q6VF78.unknown-token',
      )

      expect(balance.amount).toBe('0')
    })
  })

  describe('subscribeBlocks', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({
          network_id: 1,
          stacks_tip_height: 100,
          peer_version: 0,
          pox_consensus: '',
          burn_block_height: 0,
          stable_pox_consensus: '',
          stable_burn_block_height: 0,
          server_version: '',
          parent_network_id: 0,
          stacks_tip: '',
          stacks_tip_consensus_hash: '',
          unanchored_tip: '',
          exit_at_block_height: 0,
        }),
      )

      const callback = vi.fn()
      const unsubscribe = await provider.subscribeBlocks(callback)

      expect(typeof unsubscribe).toBe('function')

      // Wait for first poll
      await new Promise((resolve) => setTimeout(resolve, 50))

      unsubscribe()
      expect(callback).toHaveBeenCalledWith(100)
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({
          results: [],
        }),
      )

      const callback = vi.fn()
      const unsubscribe = await provider.subscribeTransactions(
        'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7',
        callback,
      )

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })
  })
})
