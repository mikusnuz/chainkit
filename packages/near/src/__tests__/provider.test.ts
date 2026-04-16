import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NearProvider } from '../provider.js'

/**
 * Mock fetch globally for RPC tests.
 * Each test configures specific mock responses.
 */
function mockRpcResponse(result: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ jsonrpc: '2.0', result }),
  })
}

function mockRpcSequence(results: unknown[]) {
  let callIndex = 0
  return vi.fn().mockImplementation(() => {
    const result = results[callIndex % results.length]
    callIndex++
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', result }),
    })
  })
}

function mockRpcError(code: number, message: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ jsonrpc: '2.0', error: { code, message } }),
  })
}

const TEST_ADDRESS = 'example.near'
const TEST_IMPLICIT_ADDRESS = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const TEST_TOKEN_CONTRACT = 'wrap.near'
const TEST_TX_HASH = '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm'

describe('NearProvider', () => {
  let provider: NearProvider
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    provider = new NearProvider({
      endpoints: ['https://rpc.mainnet.near.org'],
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('getBalance', () => {
    it('should return NEAR balance for an address', async () => {
      globalThis.fetch = mockRpcResponse({
        amount: '1500000000000000000000000',
        locked: '0',
        code_hash: '11111111111111111111111111111111',
        storage_usage: 182,
        block_height: 100000000,
        block_hash: 'abc123',
      }) as typeof fetch

      const balance = await provider.getBalance(TEST_ADDRESS)

      expect(balance.address).toBe(TEST_ADDRESS)
      expect(balance.amount).toBe('1500000000000000000000000')
      expect(balance.symbol).toBe('NEAR')
      expect(balance.decimals).toBe(24)
    })

    it('should return zero balance', async () => {
      globalThis.fetch = mockRpcResponse({
        amount: '0',
        locked: '0',
        code_hash: '11111111111111111111111111111111',
        storage_usage: 0,
        block_height: 100000000,
        block_hash: 'abc123',
      }) as typeof fetch

      const balance = await provider.getBalance(TEST_ADDRESS)
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction details', async () => {
      globalThis.fetch = mockRpcSequence([
        {
          transaction: {
            signer_id: 'sender.near',
            receiver_id: 'receiver.near',
            nonce: 42,
            actions: [{ Transfer: { deposit: '1000000000000000000000000' } }],
          },
          transaction_outcome: {
            id: TEST_TX_HASH,
            block_hash: 'blockHash123',
            outcome: {
              gas_burnt: 2428092542976,
              tokens_burnt: '242809254297600000000',
              executor_id: 'sender.near',
              status: { SuccessValue: '' },
            },
          },
          status: { SuccessValue: '' },
        },
        {
          header: {
            height: 100000000,
            hash: 'blockHash123',
            prev_hash: 'prevBlockHash',
            timestamp: 1700000000000000000,
          },
        },
      ]) as typeof fetch

      const tx = await provider.getTransaction(`${TEST_TX_HASH}:sender.near`)

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe(TEST_TX_HASH)
      expect(tx!.from).toBe('sender.near')
      expect(tx!.to).toBe('receiver.near')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.fee).toBe('242809254297600000000')
      expect(tx!.nonce).toBe(42)
      expect(tx!.blockHash).toBe('blockHash123')
      expect(tx!.timestamp).toBe(1700000000)
    })

    it('should return null for non-existent transaction', async () => {
      globalThis.fetch = mockRpcError(-32000, 'Transaction not found') as typeof fetch

      const tx = await provider.getTransaction('nonexistent:sender.near')
      expect(tx).toBeNull()
    })

    it('should handle failed transactions', async () => {
      globalThis.fetch = mockRpcSequence([
        {
          transaction: {
            signer_id: 'sender.near',
            receiver_id: 'receiver.near',
            nonce: 42,
            actions: [],
          },
          transaction_outcome: {
            id: TEST_TX_HASH,
            block_hash: 'blockHash123',
            outcome: {
              gas_burnt: 2428092542976,
              tokens_burnt: '242809254297600000000',
              executor_id: 'sender.near',
              status: { Failure: { ActionError: { kind: 'AccountDoesNotExist' } } },
            },
          },
          status: { Failure: { ActionError: { kind: 'AccountDoesNotExist' } } },
        },
        {
          header: {
            height: 100000000,
            hash: 'blockHash123',
            prev_hash: 'prevBlockHash',
            timestamp: 1700000000000000000,
          },
        },
      ]) as typeof fetch

      const tx = await provider.getTransaction(`${TEST_TX_HASH}:sender.near`)

      expect(tx).not.toBeNull()
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should return block details for a block height', async () => {
      globalThis.fetch = mockRpcResponse({
        header: {
          height: 100000000,
          hash: 'blockHash123',
          prev_hash: 'prevBlockHash',
          timestamp: 1700000000000000000,
        },
        chunks: [],
      }) as typeof fetch

      const block = await provider.getBlock(100000000)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100000000)
      expect(block!.hash).toBe('blockHash123')
      expect(block!.parentHash).toBe('prevBlockHash')
      expect(block!.timestamp).toBe(1700000000)
    })

    it('should return null for non-existent block', async () => {
      globalThis.fetch = mockRpcError(-32000, 'Block not found') as typeof fetch

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })

    it('should accept string block number', async () => {
      globalThis.fetch = mockRpcResponse({
        header: {
          height: 100000000,
          hash: 'blockHash123',
          prev_hash: 'prevBlockHash',
          timestamp: 1700000000000000000,
        },
        chunks: [],
      }) as typeof fetch

      const block = await provider.getBlock('100000000')
      expect(block).not.toBeNull()
      expect(block!.number).toBe(100000000)
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates from gas price', async () => {
      globalThis.fetch = mockRpcResponse({
        gas_price: '100000000',
      }) as typeof fetch

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('yoctoNEAR')
      expect(BigInt(fee.slow)).toBeGreaterThan(0n)
      expect(BigInt(fee.average)).toBeGreaterThanOrEqual(BigInt(fee.slow))
      expect(BigInt(fee.fast)).toBeGreaterThanOrEqual(BigInt(fee.average))
    })

    it('should return default fees when gas price fails', async () => {
      globalThis.fetch = mockRpcError(-32000, 'Internal error') as typeof fetch

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('yoctoNEAR')
      expect(fee.slow).toBe('250000000000000000000')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a transaction and return hash', async () => {
      globalThis.fetch = mockRpcResponse({
        transaction_outcome: {
          id: TEST_TX_HASH,
          outcome: { status: { SuccessValue: '' } },
        },
        status: { SuccessValue: '' },
      }) as typeof fetch

      const result = await provider.broadcastTransaction('base64encodedtx==')
      expect(result).toBe(TEST_TX_HASH)
    })
  })

  describe('getChainInfo', () => {
    it('should return mainnet info', async () => {
      globalThis.fetch = mockRpcSequence([
        {
          chain_id: 'mainnet',
          sync_info: { latest_block_height: 100000000 },
        },
        {
          header: {
            height: 100000000,
            hash: 'blockHash123',
            prev_hash: 'prevBlockHash',
            timestamp: 1700000000000000000,
          },
        },
      ]) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('mainnet')
      expect(info.name).toBe('NEAR Mainnet')
      expect(info.symbol).toBe('NEAR')
      expect(info.decimals).toBe(24)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(100000000)
    })

    it('should detect testnet', async () => {
      globalThis.fetch = mockRpcSequence([
        {
          chain_id: 'testnet',
          sync_info: { latest_block_height: 50000000 },
        },
        {
          header: {
            height: 50000000,
            hash: 'blockHash123',
            prev_hash: 'prevBlockHash',
            timestamp: 1700000000000000000,
          },
        },
      ]) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.name).toBe('NEAR Testnet')
      expect(info.testnet).toBe(true)
    })
  })

  describe('getTokenBalance', () => {
    it('should return NEP-141 token balance', async () => {
      const balanceBytes = new TextEncoder().encode('"1000000000000000000"')
      const metadataBytes = new TextEncoder().encode(
        JSON.stringify({ name: 'Wrapped NEAR', symbol: 'wNEAR', decimals: 24 }),
      )

      globalThis.fetch = mockRpcSequence([
        {
          result: Array.from(balanceBytes),
          logs: [],
        },
        {
          result: Array.from(metadataBytes),
          logs: [],
        },
      ]) as typeof fetch

      const balance = await provider.getTokenBalance(TEST_ADDRESS, TEST_TOKEN_CONTRACT)

      expect(balance.address).toBe(TEST_ADDRESS)
      expect(balance.amount).toBe('1000000000000000000')
      expect(balance.symbol).toBe('wNEAR')
      expect(balance.decimals).toBe(24)
    })

    it('should return zero for failed token query', async () => {
      globalThis.fetch = mockRpcError(-32000, 'Account not found') as typeof fetch

      const balance = await provider.getTokenBalance(TEST_ADDRESS, TEST_TOKEN_CONTRACT)

      expect(balance.amount).toBe('0')
      expect(balance.decimals).toBe(0)
    })
  })

  describe('getTokenMetadata', () => {
    it('should return NEP-141 token metadata', async () => {
      const metadataBytes = new TextEncoder().encode(
        JSON.stringify({
          name: 'Wrapped NEAR',
          symbol: 'wNEAR',
          decimals: 24,
          icon: null,
        }),
      )
      const supplyBytes = new TextEncoder().encode('"50000000000000000000000000000"')

      globalThis.fetch = mockRpcSequence([
        {
          result: Array.from(metadataBytes),
          logs: [],
        },
        {
          result: Array.from(supplyBytes),
          logs: [],
        },
      ]) as typeof fetch

      const metadata = await provider.getTokenMetadata(TEST_TOKEN_CONTRACT)

      expect(metadata.address).toBe(TEST_TOKEN_CONTRACT)
      expect(metadata.name).toBe('Wrapped NEAR')
      expect(metadata.symbol).toBe('wNEAR')
      expect(metadata.decimals).toBe(24)
      expect(metadata.totalSupply).toBe('50000000000000000000000000000')
    })
  })

  describe('callContract', () => {
    it('should call a view function and return result', async () => {
      const resultBytes = new TextEncoder().encode('"1000000000000000000"')

      globalThis.fetch = mockRpcResponse({
        result: Array.from(resultBytes),
        logs: [],
        block_height: 100000000,
        block_hash: 'blockHash123',
      }) as typeof fetch

      const result = await provider.callContract(
        TEST_TOKEN_CONTRACT,
        'ft_balance_of',
        [{ account_id: TEST_ADDRESS }],
      )

      expect(result).toBe('1000000000000000000')
    })
  })

  describe('estimateGas', () => {
    it('should return standard gas for contract calls', async () => {
      const gas = await provider.estimateGas(TEST_TOKEN_CONTRACT, 'ft_transfer')
      expect(gas).toBe('30000000000000')
    })

    it('should return lower gas for transfers', async () => {
      const gas = await provider.estimateGas(TEST_ADDRESS, 'transfer')
      expect(gas).toBe('2500000000000')
    })
  })

  describe('subscribeBlocks', () => {
    it('should call callback with new block heights', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              jsonrpc: '2.0',
              id: callCount,
              result: {
                header: {
                  height: 100000000 + callCount,
                  hash: `blockHash${callCount}`,
                  prev_hash: 'prevBlockHash',
                  timestamp: 1700000000000000000,
                },
                chunks: [],
              },
            }),
        })
      }) as typeof fetch

      const received: number[] = []
      const unsubscribe = await provider.subscribeBlocks((height) => {
        received.push(height)
      })

      // Wait a bit for polling
      await new Promise((resolve) => setTimeout(resolve, 100))

      unsubscribe()

      expect(received.length).toBeGreaterThanOrEqual(1)
      expect(received[0]).toBeGreaterThan(0)
    })
  })

  describe('subscribeTransactions', () => {
    it('should subscribe and unsubscribe without error', async () => {
      globalThis.fetch = mockRpcResponse({
        header: {
          height: 100000000,
          hash: 'blockHash123',
          prev_hash: 'prevBlockHash',
          timestamp: 1700000000000000000,
        },
        chunks: [],
      }) as typeof fetch

      const unsubscribe = await provider.subscribeTransactions(
        TEST_ADDRESS,
        () => {},
      )

      // Give it a moment to start polling
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should not throw
      unsubscribe()
    })
  })
})
