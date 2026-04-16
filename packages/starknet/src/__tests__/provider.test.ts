import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils'
import { StarknetProvider } from '../provider.js'

/**
 * Encode a string to hex (portable, no Buffer dependency).
 */
function strToHex(str: string): string {
  const bytes = new TextEncoder().encode(str)
  return bytesToHex(bytes)
}

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
      json: () => Promise.resolve({ jsonrpc: '2.0', id: callIndex, result }),
    })
  })
}

function mockRpcError(code: number, message: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ jsonrpc: '2.0', error: { code, message } }),
  })
}

const TEST_ADDRESS = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'
const TEST_TOKEN_ADDRESS = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
const TEST_TX_HASH = '0x06a09ccb1caaecf3d9683efe335a667b2169a409d19c589ba1eb771cd210af75'

describe('StarknetProvider', () => {
  let provider: StarknetProvider
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    provider = new StarknetProvider({
      endpoints: ['https://starknet-mainnet.public.blastapi.io'],
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('getBalance', () => {
    it('should return STRK balance for an address', async () => {
      // balanceOf returns [low, high] as u256
      globalThis.fetch = mockRpcResponse([
        '0x2386f26fc10000', // 10000000000000000 (0.01 STRK)
        '0x0',
      ]) as typeof fetch

      const balance = await provider.getBalance(TEST_ADDRESS)

      expect(balance.address).toBe(TEST_ADDRESS)
      expect(balance.amount).toBe('10000000000000000')
      expect(balance.symbol).toBe('STRK')
      expect(balance.decimals).toBe(18)
    })

    it('should handle u256 with high part', async () => {
      globalThis.fetch = mockRpcResponse([
        '0xffffffffffffffffffffffffffffffff', // max u128 low
        '0x1', // 1 in high
      ]) as typeof fetch

      const balance = await provider.getBalance(TEST_ADDRESS)

      const expectedLow = BigInt('0xffffffffffffffffffffffffffffffff')
      const expectedHigh = 1n << 128n
      expect(balance.amount).toBe((expectedLow + expectedHigh).toString())
    })

    it('should return zero balance on error', async () => {
      globalThis.fetch = mockRpcError(-32000, 'Contract not found') as typeof fetch

      const balance = await provider.getBalance(TEST_ADDRESS)
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction details', async () => {
      globalThis.fetch = mockRpcSequence([
        // starknet_getTransactionByHash
        {
          transaction_hash: TEST_TX_HASH,
          sender_address: '0x01234',
          calldata: ['0x05678'],
          nonce: '0x2a',
          type: 'INVOKE',
          version: '0x1',
        },
        // starknet_getTransactionReceipt
        {
          transaction_hash: TEST_TX_HASH,
          execution_status: 'SUCCEEDED',
          finality_status: 'ACCEPTED_ON_L2',
          actual_fee: { amount: '0x2386f26fc10000', unit: 'WEI' },
          block_number: 100000,
          block_hash: '0xblockhash123',
        },
        // starknet_getBlockWithTxHashes (for timestamp)
        {
          block_number: 100000,
          block_hash: '0xblockhash123',
          parent_hash: '0xparenthash',
          timestamp: 1700000000,
          transactions: [TEST_TX_HASH],
        },
      ]) as typeof fetch

      const tx = await provider.getTransaction(TEST_TX_HASH)

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe(TEST_TX_HASH)
      expect(tx!.from).toBe('0x01234')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.fee).toBe('10000000000000000')
      expect(tx!.blockNumber).toBe(100000)
      expect(tx!.blockHash).toBe('0xblockhash123')
      expect(tx!.nonce).toBe(42)
      expect(tx!.timestamp).toBe(1700000000)
    })

    it('should return null for non-existent transaction', async () => {
      globalThis.fetch = mockRpcError(-32000, 'Transaction not found') as typeof fetch

      const tx = await provider.getTransaction('0xnonexistent')
      expect(tx).toBeNull()
    })

    it('should handle reverted transactions', async () => {
      globalThis.fetch = mockRpcSequence([
        {
          transaction_hash: TEST_TX_HASH,
          sender_address: '0x01234',
          calldata: [],
          nonce: '0x1',
          type: 'INVOKE',
        },
        {
          transaction_hash: TEST_TX_HASH,
          execution_status: 'REVERTED',
          finality_status: 'ACCEPTED_ON_L2',
          actual_fee: { amount: '0x100', unit: 'WEI' },
          block_number: 100001,
          block_hash: '0xblockhash456',
        },
        {
          block_number: 100001,
          block_hash: '0xblockhash456',
          parent_hash: '0xparenthash',
          timestamp: 1700000100,
          transactions: [],
        },
      ]) as typeof fetch

      const tx = await provider.getTransaction(TEST_TX_HASH)
      expect(tx).not.toBeNull()
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should return block details for a block number', async () => {
      globalThis.fetch = mockRpcResponse({
        block_number: 100000,
        block_hash: '0xblockhash123',
        parent_hash: '0xparenthash',
        timestamp: 1700000000,
        transactions: [TEST_TX_HASH],
      }) as typeof fetch

      const block = await provider.getBlock(100000)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100000)
      expect(block!.hash).toBe('0xblockhash123')
      expect(block!.parentHash).toBe('0xparenthash')
      expect(block!.timestamp).toBe(1700000000)
      expect(block!.transactions).toContain(TEST_TX_HASH)
    })

    it('should return null for non-existent block', async () => {
      globalThis.fetch = mockRpcError(-32000, 'Block not found') as typeof fetch

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })

    it('should accept block hash', async () => {
      const blockHash = '0x' + '1'.repeat(64)
      globalThis.fetch = mockRpcResponse({
        block_number: 100000,
        block_hash: blockHash,
        parent_hash: '0xparenthash',
        timestamp: 1700000000,
        transactions: [],
      }) as typeof fetch

      const block = await provider.getBlock(blockHash)
      expect(block).not.toBeNull()
      expect(block!.hash).toBe(blockHash)
    })

    it('should accept string block number', async () => {
      globalThis.fetch = mockRpcResponse({
        block_number: 100000,
        block_hash: '0xblockhash123',
        parent_hash: '0xparenthash',
        timestamp: 1700000000,
        transactions: [],
      }) as typeof fetch

      const block = await provider.getBlock('100000')
      expect(block).not.toBeNull()
      expect(block!.number).toBe(100000)
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates from gas price', async () => {
      globalThis.fetch = mockRpcResponse({
        block_number: 100000,
        block_hash: '0xblockhash',
        parent_hash: '0xparent',
        timestamp: 1700000000,
        transactions: [],
        l1_gas_price: {
          price_in_wei: '0xe8d4a51000', // 1000000000000
          price_in_fri: '0x0',
        },
      }) as typeof fetch

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('wei')
      expect(BigInt(fee.slow)).toBeGreaterThan(0n)
      expect(BigInt(fee.average)).toBeGreaterThanOrEqual(BigInt(fee.slow))
      expect(BigInt(fee.fast)).toBeGreaterThanOrEqual(BigInt(fee.average))
    })

    it('should return default fees when gas price fails', async () => {
      globalThis.fetch = mockRpcError(-32000, 'Internal error') as typeof fetch

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('wei')
      expect(fee.slow).toBe('1000000000000')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a transaction and return hash', async () => {
      globalThis.fetch = mockRpcResponse({
        transaction_hash: TEST_TX_HASH,
      }) as typeof fetch

      const txBody = JSON.stringify({
        type: 'INVOKE',
        version: '0x1',
        sender_address: TEST_ADDRESS,
        calldata: [],
        max_fee: '0x100',
        signature: ['0x1', '0x2'],
        nonce: '0x0',
      })

      const result = await provider.broadcastTransaction(txBody)
      expect(result).toBe(TEST_TX_HASH)
    })
  })

  describe('getChainInfo', () => {
    it('should return mainnet info', async () => {
      // SN_MAIN encoded as hex ASCII
      const snMainHex = '0x' + strToHex('SN_MAIN')

      globalThis.fetch = mockRpcSequence([
        snMainHex,
        {
          block_number: 100000,
          block_hash: '0xblockhash',
          parent_hash: '0xparent',
          timestamp: 1700000000,
          transactions: [],
        },
      ]) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe(snMainHex)
      expect(info.name).toBe('StarkNet Mainnet')
      expect(info.symbol).toBe('STRK')
      expect(info.decimals).toBe(18)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(100000)
    })

    it('should detect testnet', async () => {
      const snSepoliaHex = '0x' + strToHex('SN_SEPOLIA')

      globalThis.fetch = mockRpcSequence([
        snSepoliaHex,
        {
          block_number: 50000,
          block_hash: '0xblockhash',
          parent_hash: '0xparent',
          timestamp: 1700000000,
          transactions: [],
        },
      ]) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.name).toBe('StarkNet Sepolia')
      expect(info.testnet).toBe(true)
    })
  })

  describe('getTokenBalance', () => {
    it('should return ERC-20 token balance', async () => {
      globalThis.fetch = mockRpcSequence([
        // balanceOf response
        ['0xde0b6b3a7640000', '0x0'], // 1e18
        // name response
        ['0x' + strToHex('Wrapped ETH')],
        // symbol response
        ['0x' + strToHex('WETH')],
        // decimals response
        ['0x12'], // 18
      ]) as typeof fetch

      const balance = await provider.getTokenBalance(TEST_ADDRESS, TEST_TOKEN_ADDRESS)

      expect(balance.address).toBe(TEST_ADDRESS)
      expect(balance.amount).toBe('1000000000000000000')
      expect(balance.symbol).toBe('WETH')
      expect(balance.decimals).toBe(18)
    })

    it('should return zero for failed token query', async () => {
      globalThis.fetch = mockRpcError(-32000, 'Contract not found') as typeof fetch

      const balance = await provider.getTokenBalance(TEST_ADDRESS, TEST_TOKEN_ADDRESS)

      expect(balance.amount).toBe('0')
      expect(balance.decimals).toBe(0)
    })
  })

  describe('getTokenMetadata', () => {
    it('should return ERC-20 token metadata', async () => {
      globalThis.fetch = mockRpcSequence([
        // name
        ['0x' + strToHex('StarkNet Token')],
        // symbol
        ['0x' + strToHex('STRK')],
        // decimals
        ['0x12'], // 18
        // totalSupply
        ['0x52b7d2dcc80cd2e4000000', '0x0'], // 100000000e18
      ]) as typeof fetch

      const metadata = await provider.getTokenMetadata(TEST_TOKEN_ADDRESS)

      expect(metadata.address).toBe(TEST_TOKEN_ADDRESS)
      expect(metadata.name).toBe('StarkNet Token')
      expect(metadata.symbol).toBe('STRK')
      expect(metadata.decimals).toBe(18)
      expect(metadata.totalSupply).toBeDefined()
    })
  })

  describe('callContract', () => {
    it('should call a contract function with a selector', async () => {
      globalThis.fetch = mockRpcResponse([
        '0x2386f26fc10000',
      ]) as typeof fetch

      const result = await provider.callContract(
        TEST_TOKEN_ADDRESS,
        '0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e',
        [TEST_ADDRESS],
      )

      expect(result).toEqual(['0x2386f26fc10000'])
    })

    it('should look up known function names', async () => {
      globalThis.fetch = mockRpcResponse([
        '0x12', // 18 decimals
      ]) as typeof fetch

      const result = await provider.callContract(
        TEST_TOKEN_ADDRESS,
        'decimals',
      )

      expect(result).toEqual(['0x12'])
    })
  })

  describe('estimateGas', () => {
    it('should return gas estimate for a contract call', async () => {
      globalThis.fetch = mockRpcResponse([
        {
          overall_fee: '0x4a817c800', // 20000000000
          gas_consumed: '0x1000',
          gas_price: '0x4a817c8',
        },
      ]) as typeof fetch

      const gas = await provider.estimateGas(TEST_TOKEN_ADDRESS, 'transfer')
      expect(BigInt(gas)).toBeGreaterThan(0n)
    })

    it('should return fallback estimate on failure', async () => {
      globalThis.fetch = mockRpcError(-32000, 'Estimation failed') as typeof fetch

      const gas = await provider.estimateGas(TEST_TOKEN_ADDRESS, 'transfer')
      expect(gas).toBe('5000000000000')
    })
  })

  describe('subscribeBlocks', () => {
    it('should call callback with new block numbers', async () => {
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
                block_number: 100000 + callCount,
                block_hash: `0xblockhash${callCount}`,
                parent_hash: '0xparenthash',
                timestamp: 1700000000,
                transactions: [],
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
        block_number: 100000,
        block_hash: '0xblockhash',
        parent_hash: '0xparenthash',
        timestamp: 1700000000,
        transactions: [],
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
