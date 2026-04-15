import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AlgorandProvider } from '../provider.js'

/**
 * Mock fetch for Algod REST API tests.
 */
function mockRestResponse(result: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(result),
    text: () => Promise.resolve(JSON.stringify(result)),
  })
}

function mockRestSequence(results: unknown[]) {
  let callIndex = 0
  return vi.fn().mockImplementation(() => {
    const result = results[callIndex % results.length]
    callIndex++
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(result),
      text: () => Promise.resolve(JSON.stringify(result)),
    })
  })
}

function mockRestError(status: number, message: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ message }),
    text: () => Promise.resolve(message),
  })
}

const TEST_ADDRESS = 'VCMJKWOY5P5P7SKMZFFOCEROPJCZLMOUNRLJ3GCZFPYEZB6MVLSEQCDGE'
const TEST_ASSET_ID = '31566704'
const TEST_TX_ID = 'GHIJKLMNOPQRSTUV1234567890ABCDEFGHIJKLMNOPQRSTUV12'

describe('AlgorandProvider', () => {
  let provider: AlgorandProvider
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    provider = new AlgorandProvider({
      baseUrl: 'https://testnet-api.algonode.cloud',
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('getBalance', () => {
    it('should return ALGO balance for an address', async () => {
      globalThis.fetch = mockRestResponse({
        amount: 5000000,
        'min-balance': 100000,
        status: 'Online',
      }) as typeof fetch

      const balance = await provider.getBalance(TEST_ADDRESS)

      expect(balance.address).toBe(TEST_ADDRESS)
      expect(balance.amount).toBe('5000000')
      expect(balance.symbol).toBe('ALGO')
      expect(balance.decimals).toBe(6)
    })

    it('should return zero balance', async () => {
      globalThis.fetch = mockRestResponse({
        amount: 0,
        'min-balance': 100000,
        status: 'Offline',
      }) as typeof fetch

      const balance = await provider.getBalance(TEST_ADDRESS)
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTransaction', () => {
    it('should return confirmed transaction details', async () => {
      globalThis.fetch = mockRestResponse({
        'pool-error': '',
        txn: {
          txn: {
            type: 'pay',
            snd: TEST_ADDRESS,
            rcv: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            amt: 1000000,
            fee: 1000,
            fv: 100,
            lv: 200,
            gh: 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
            gen: 'testnet-v1.0',
          },
        },
        'confirmed-round': 12345,
      }) as typeof fetch

      const tx = await provider.getTransaction(TEST_TX_ID)

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe(TEST_TX_ID)
      expect(tx!.from).toBe(TEST_ADDRESS)
      expect(tx!.to).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
      expect(tx!.value).toBe('1000000')
      expect(tx!.fee).toBe('1000')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(12345)
    })

    it('should return pending transaction details', async () => {
      globalThis.fetch = mockRestResponse({
        'pool-error': '',
        txn: {
          txn: {
            type: 'pay',
            snd: TEST_ADDRESS,
            rcv: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            amt: 500000,
            fee: 1000,
            fv: 100,
            lv: 200,
            gh: 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
          },
        },
      }) as typeof fetch

      const tx = await provider.getTransaction(TEST_TX_ID)

      expect(tx).not.toBeNull()
      expect(tx!.status).toBe('pending')
      expect(tx!.blockNumber).toBeNull()
    })

    it('should return failed transaction', async () => {
      globalThis.fetch = mockRestResponse({
        'pool-error': 'transaction rejected',
        txn: {
          txn: {
            type: 'pay',
            snd: TEST_ADDRESS,
            amt: 0,
            fee: 1000,
            fv: 100,
            lv: 200,
            gh: 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
          },
        },
      }) as typeof fetch

      const tx = await provider.getTransaction(TEST_TX_ID)

      expect(tx).not.toBeNull()
      expect(tx!.status).toBe('failed')
    })

    it('should return null for non-existent transaction', async () => {
      globalThis.fetch = mockRestError(404, 'not found') as typeof fetch

      const tx = await provider.getTransaction('nonexistent')
      expect(tx).toBeNull()
    })
  })

  describe('getBlock', () => {
    it('should return block details for a round number', async () => {
      globalThis.fetch = mockRestResponse({
        block: {
          rnd: 12345,
          gh: 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
          prev: 'prevBlockHash123',
          ts: 1700000000,
          txns: [
            { txn: { txn: { type: 'pay' } }, txID: 'tx1' },
            { txn: { txn: { type: 'pay' } }, txID: 'tx2' },
          ],
        },
      }) as typeof fetch

      const block = await provider.getBlock(12345)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(12345)
      expect(block!.hash).toBe('wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=')
      expect(block!.parentHash).toBe('prevBlockHash123')
      expect(block!.timestamp).toBe(1700000000)
      expect(block!.transactions).toContain('tx1')
      expect(block!.transactions).toContain('tx2')
    })

    it('should return null for non-existent round', async () => {
      globalThis.fetch = mockRestError(404, 'round not found') as typeof fetch

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })

    it('should accept string round number', async () => {
      globalThis.fetch = mockRestResponse({
        block: {
          rnd: 12345,
          gh: 'abc123',
          prev: 'def456',
          ts: 1700000000,
          txns: [],
        },
      }) as typeof fetch

      const block = await provider.getBlock('12345')
      expect(block).not.toBeNull()
      expect(block!.number).toBe(12345)
    })

    it('should handle blocks with no transactions', async () => {
      globalThis.fetch = mockRestResponse({
        block: {
          rnd: 100,
          gh: 'genesishash',
          prev: 'prevhash',
          ts: 1700000000,
        },
      }) as typeof fetch

      const block = await provider.getBlock(100)
      expect(block).not.toBeNull()
      expect(block!.transactions).toEqual([])
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates from transaction params', async () => {
      globalThis.fetch = mockRestResponse({
        fee: 1000,
        'min-fee': 1000,
        'last-round': 12345,
        'genesis-hash': 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
        'genesis-id': 'testnet-v1.0',
        'consensus-version': 'v38',
      }) as typeof fetch

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('microAlgo')
      expect(fee.slow).toBe('1000')
      expect(fee.average).toBe('1000')
      expect(fee.fast).toBe('2000')
    })

    it('should use min-fee when fee is 0', async () => {
      globalThis.fetch = mockRestResponse({
        fee: 0,
        'min-fee': 1000,
        'last-round': 12345,
        'genesis-hash': 'hash',
        'genesis-id': 'testnet-v1.0',
        'consensus-version': 'v38',
      }) as typeof fetch

      const fee = await provider.estimateFee()

      expect(fee.slow).toBe('1000')
      expect(fee.average).toBe('1000')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a transaction and return txId', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ txId: TEST_TX_ID }),
      }) as typeof fetch

      const result = await provider.broadcastTransaction('0xdeadbeef')
      expect(result).toBe(TEST_TX_ID)
    })

    it('should throw on broadcast failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('overspend'),
      }) as typeof fetch

      await expect(
        provider.broadcastTransaction('0xdeadbeef'),
      ).rejects.toThrow('Failed to broadcast')
    })
  })

  describe('getChainInfo', () => {
    it('should return mainnet info', async () => {
      globalThis.fetch = mockRestSequence([
        {
          'genesis-id': 'mainnet-v1.0',
          'genesis-hash': 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
          'last-round': 30000000,
        },
        {
          'last-round': 30000000,
          'last-version': 'v38',
        },
      ]) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=')
      expect(info.name).toBe('Algorand Mainnet')
      expect(info.symbol).toBe('ALGO')
      expect(info.decimals).toBe(6)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(30000000)
    })

    it('should detect testnet', async () => {
      globalThis.fetch = mockRestSequence([
        {
          'genesis-id': 'testnet-v1.0',
          'genesis-hash': 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
          'last-round': 10000000,
        },
        {
          'last-round': 10000000,
          'last-version': 'v38',
        },
      ]) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Algorand Testnet')
      expect(info.testnet).toBe(true)
    })

    it('should detect betanet', async () => {
      globalThis.fetch = mockRestSequence([
        {
          'genesis-id': 'betanet-v1.0',
          'genesis-hash': 'betaHash123',
          'last-round': 5000000,
        },
        {
          'last-round': 5000000,
          'last-version': 'v38',
        },
      ]) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Algorand Betanet')
      expect(info.testnet).toBe(true)
    })
  })

  describe('getTokenBalance', () => {
    it('should return ASA token balance', async () => {
      globalThis.fetch = mockRestSequence([
        {
          assets: [
            { 'asset-id': 31566704, amount: 1000000, 'is-frozen': false },
            { 'asset-id': 99999, amount: 500, 'is-frozen': false },
          ],
        },
        {
          params: {
            decimals: 6,
            'unit-name': 'USDC',
            name: 'USD Coin',
            total: 10000000000,
          },
        },
      ]) as typeof fetch

      const balance = await provider.getTokenBalance(TEST_ADDRESS, TEST_ASSET_ID)

      expect(balance.address).toBe(TEST_ADDRESS)
      expect(balance.amount).toBe('1000000')
      expect(balance.symbol).toBe('USDC')
      expect(balance.decimals).toBe(6)
    })

    it('should return zero for non-opted-in asset', async () => {
      globalThis.fetch = mockRestResponse({
        assets: [],
      }) as typeof fetch

      const balance = await provider.getTokenBalance(TEST_ADDRESS, TEST_ASSET_ID)

      expect(balance.amount).toBe('0')
      expect(balance.decimals).toBe(0)
    })
  })

  describe('getTokenMetadata', () => {
    it('should return ASA metadata', async () => {
      globalThis.fetch = mockRestResponse({
        params: {
          decimals: 6,
          'unit-name': 'USDC',
          name: 'USD Coin',
          total: 10000000000,
          creator: TEST_ADDRESS,
        },
      }) as typeof fetch

      const metadata = await provider.getTokenMetadata(TEST_ASSET_ID)

      expect(metadata.address).toBe(TEST_ASSET_ID)
      expect(metadata.name).toBe('USD Coin')
      expect(metadata.symbol).toBe('USDC')
      expect(metadata.decimals).toBe(6)
      expect(metadata.totalSupply).toBe('10000000000')
    })

    it('should throw for non-existent asset', async () => {
      globalThis.fetch = mockRestError(404, 'asset not found') as typeof fetch

      await expect(
        provider.getTokenMetadata('999999999'),
      ).rejects.toThrow()
    })
  })

  describe('callContract (dryrun)', () => {
    it('should simulate an application call', async () => {
      globalThis.fetch = mockRestResponse({
        txns: [
          {
            'app-call-messages': ['PASS'],
            'global-delta': [],
            'local-deltas': [],
          },
        ],
      }) as typeof fetch

      const result = await provider.callContract('12345', 'method_selector')

      expect(result).toBeDefined()
    })
  })

  describe('estimateGas', () => {
    it('should return minimum fee from transaction params', async () => {
      globalThis.fetch = mockRestResponse({
        'min-fee': 1000,
        fee: 0,
      }) as typeof fetch

      const gas = await provider.estimateGas('12345', 'method_selector')

      expect(gas).toBe('1000')
    })

    it('should use the higher of fee and min-fee', async () => {
      globalThis.fetch = mockRestResponse({
        'min-fee': 1000,
        fee: 2000,
      }) as typeof fetch

      const gas = await provider.estimateGas('12345', 'method_selector')

      expect(gas).toBe('2000')
    })
  })

  describe('subscribeBlocks', () => {
    it('should call callback with new round numbers', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ 'last-round': 100 + callCount }),
        })
      }) as typeof fetch

      const received: number[] = []
      const unsubscribe = await provider.subscribeBlocks((round) => {
        received.push(round)
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
      globalThis.fetch = mockRestResponse({
        'last-round': 12345,
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
