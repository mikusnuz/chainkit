import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StellarProvider } from '../provider.js'

/**
 * Mock fetch for Horizon REST API tests.
 */
function mockHorizonResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

function mockHorizonSequence(responses: Array<{ body: unknown; status?: number }>) {
  let callIndex = 0
  return vi.fn().mockImplementation(() => {
    const resp = responses[callIndex % responses.length]
    callIndex++
    const status = resp.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: () => Promise.resolve(resp.body),
      text: () => Promise.resolve(JSON.stringify(resp.body)),
    })
  })
}

const TEST_ADDRESS = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOBD3CAZEAIORB2'
const TEST_TX_HASH = 'abc123def456789012345678901234567890123456789012345678901234abcd'
const TEST_ASSET = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

describe('StellarProvider', () => {
  let provider: StellarProvider
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    provider = new StellarProvider({
      horizonUrl: 'https://horizon.stellar.org',
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('should throw when no horizonUrl is provided', () => {
    expect(() => new StellarProvider({ horizonUrl: '' })).toThrow('Horizon URL is required')
  })

  describe('getBalance', () => {
    it('should return XLM balance for an address', async () => {
      globalThis.fetch = mockHorizonResponse({
        balances: [
          { asset_type: 'native', balance: '150.0000000' },
          { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '100.0000000' },
        ],
      }) as typeof fetch

      const balance = await provider.getBalance(TEST_ADDRESS)

      expect(balance.address).toBe(TEST_ADDRESS)
      expect(balance.amount).toBe('1500000000')
      expect(balance.symbol).toBe('XLM')
      expect(balance.decimals).toBe(7)
    })

    it('should return zero balance for unfunded account', async () => {
      globalThis.fetch = mockHorizonResponse({ status: 404 }, 404) as typeof fetch

      const balance = await provider.getBalance(TEST_ADDRESS)
      expect(balance.amount).toBe('0')
      expect(balance.symbol).toBe('XLM')
    })
  })

  describe('getTransaction', () => {
    it('should return transaction details', async () => {
      globalThis.fetch = mockHorizonSequence([
        {
          body: {
            hash: TEST_TX_HASH,
            source_account: TEST_ADDRESS,
            fee_charged: '100',
            created_at: '2024-01-01T00:00:00Z',
            successful: true,
            ledger: 12345678,
            source_account_sequence: '12345',
            envelope_xdr: '',
            result_xdr: '',
          },
        },
        {
          body: {
            _embedded: {
              records: [
                {
                  type: 'payment',
                  to: 'GBZH4AOKPDF3JLLBAXAFMQPH4ERAUQMGIYRFH3USJC5VWTIHGI7AZFN',
                  amount: '50.0000000',
                },
              ],
            },
          },
        },
      ]) as typeof fetch

      const tx = await provider.getTransaction(TEST_TX_HASH)

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe(TEST_TX_HASH)
      expect(tx!.from).toBe(TEST_ADDRESS)
      expect(tx!.to).toBe('GBZH4AOKPDF3JLLBAXAFMQPH4ERAUQMGIYRFH3USJC5VWTIHGI7AZFN')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.fee).toBe('100')
      expect(tx!.value).toBe('500000000')
      expect(tx!.blockNumber).toBe(12345678)
    })

    it('should return null for non-existent transaction', async () => {
      globalThis.fetch = mockHorizonResponse({ status: 404 }, 404) as typeof fetch

      const tx = await provider.getTransaction('nonexistent')
      expect(tx).toBeNull()
    })

    it('should handle failed transactions', async () => {
      globalThis.fetch = mockHorizonSequence([
        {
          body: {
            hash: TEST_TX_HASH,
            source_account: TEST_ADDRESS,
            fee_charged: '100',
            created_at: '2024-01-01T00:00:00Z',
            successful: false,
            ledger: 12345678,
            source_account_sequence: '12345',
            envelope_xdr: '',
            result_xdr: '',
          },
        },
        {
          body: {
            _embedded: { records: [] },
          },
        },
      ]) as typeof fetch

      const tx = await provider.getTransaction(TEST_TX_HASH)

      expect(tx).not.toBeNull()
      expect(tx!.status).toBe('failed')
    })
  })

  describe('getBlock', () => {
    it('should return ledger details for a sequence number', async () => {
      globalThis.fetch = mockHorizonSequence([
        {
          body: {
            sequence: 12345678,
            hash: 'ledgerhash123',
            prev_hash: 'prevhash456',
            closed_at: '2024-01-01T00:00:00Z',
            transaction_count: 5,
          },
        },
        {
          body: {
            _embedded: {
              records: [
                { hash: 'tx1' },
                { hash: 'tx2' },
              ],
            },
          },
        },
      ]) as typeof fetch

      const block = await provider.getBlock(12345678)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(12345678)
      expect(block!.hash).toBe('ledgerhash123')
      expect(block!.parentHash).toBe('prevhash456')
      expect(block!.transactions).toContain('tx1')
      expect(block!.transactions).toContain('tx2')
    })

    it('should return null for non-existent ledger', async () => {
      globalThis.fetch = mockHorizonResponse({ status: 404 }, 404) as typeof fetch

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })

    it('should accept string sequence number', async () => {
      globalThis.fetch = mockHorizonSequence([
        {
          body: {
            sequence: 12345678,
            hash: 'hash123',
            prev_hash: 'prev456',
            closed_at: '2024-01-01T00:00:00Z',
            transaction_count: 0,
          },
        },
        {
          body: { _embedded: { records: [] } },
        },
      ]) as typeof fetch

      const block = await provider.getBlock('12345678')
      expect(block).not.toBeNull()
      expect(block!.number).toBe(12345678)
    })

    it('should reject invalid sequence number', async () => {
      await expect(provider.getBlock('notanumber')).rejects.toThrow('Invalid ledger sequence')
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates from fee_stats', async () => {
      globalThis.fetch = mockHorizonResponse({
        last_ledger_base_fee: '100',
        last_ledger: '50000000',
        ledger_capacity_usage: '0.5',
        fee_charged: {
          max: '10000',
          min: '100',
          mode: '100',
          p10: '100',
          p20: '100',
          p30: '100',
          p40: '100',
          p50: '100',
          p60: '100',
          p70: '100',
          p80: '200',
          p90: '500',
          p95: '1000',
          p99: '5000',
        },
      }) as typeof fetch

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('stroops')
      expect(fee.slow).toBe('100')
      expect(fee.average).toBe('100')
      expect(fee.fast).toBe('1000')
    })

    it('should return default fees on error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as typeof fetch

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('stroops')
      expect(fee.slow).toBe('100')
      expect(fee.average).toBe('100')
      expect(fee.fast).toBe('200')
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a transaction and return hash', async () => {
      globalThis.fetch = mockHorizonResponse({
        hash: TEST_TX_HASH,
        ledger: 12345678,
      }) as typeof fetch

      const result = await provider.broadcastTransaction('base64encodedxdr==')
      expect(result).toBe(TEST_TX_HASH)
    })

    it('should throw on broadcast failure', async () => {
      globalThis.fetch = mockHorizonResponse(
        { title: 'Transaction Failed' },
        400,
      ) as typeof fetch

      await expect(provider.broadcastTransaction('badtx')).rejects.toThrow(
        'Transaction submission failed',
      )
    })
  })

  describe('getChainInfo', () => {
    it('should return mainnet info', async () => {
      globalThis.fetch = mockHorizonResponse({
        horizon_version: '2.28.0',
        core_version: 'v20.0.0',
        network_passphrase: 'Public Global Stellar Network ; September 2015',
        history_latest_ledger: 50000000,
      }) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('Public Global Stellar Network ; September 2015')
      expect(info.name).toBe('Stellar Mainnet')
      expect(info.symbol).toBe('XLM')
      expect(info.decimals).toBe(7)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(50000000)
    })

    it('should detect testnet', async () => {
      globalThis.fetch = mockHorizonResponse({
        horizon_version: '2.28.0',
        core_version: 'v20.0.0',
        network_passphrase: 'Test SDF Network ; September 2015',
        history_latest_ledger: 1000000,
      }) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.name).toBe('Stellar Testnet')
      expect(info.testnet).toBe(true)
    })

    it('should handle unknown networks', async () => {
      globalThis.fetch = mockHorizonResponse({
        horizon_version: '2.28.0',
        core_version: 'v20.0.0',
        network_passphrase: 'My Custom Network',
        history_latest_ledger: 100,
      }) as typeof fetch

      const info = await provider.getChainInfo()

      expect(info.name).toContain('My Custom Network')
      expect(info.testnet).toBe(true)
    })
  })

  describe('getTokenBalance', () => {
    it('should return asset balance', async () => {
      globalThis.fetch = mockHorizonResponse({
        balances: [
          { asset_type: 'native', balance: '100.0000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            balance: '250.5000000',
          },
        ],
      }) as typeof fetch

      const balance = await provider.getTokenBalance(TEST_ADDRESS, TEST_ASSET)

      expect(balance.address).toBe(TEST_ADDRESS)
      expect(balance.amount).toBe('2505000000')
      expect(balance.symbol).toBe('USDC')
      expect(balance.decimals).toBe(7)
    })

    it('should return zero for non-held asset', async () => {
      globalThis.fetch = mockHorizonResponse({
        balances: [
          { asset_type: 'native', balance: '100.0000000' },
        ],
      }) as typeof fetch

      const balance = await provider.getTokenBalance(TEST_ADDRESS, TEST_ASSET)

      expect(balance.amount).toBe('0')
    })

    it('should return zero for unfunded account', async () => {
      globalThis.fetch = mockHorizonResponse({ status: 404 }, 404) as typeof fetch

      const balance = await provider.getTokenBalance(TEST_ADDRESS, TEST_ASSET)
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTokenMetadata', () => {
    it('should return asset metadata', async () => {
      globalThis.fetch = mockHorizonResponse({
        _embedded: {
          records: [
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
              amount: '1000000.0000000',
              num_accounts: 50000,
            },
          ],
        },
      }) as typeof fetch

      const metadata = await provider.getTokenMetadata(TEST_ASSET)

      expect(metadata.address).toBe(TEST_ASSET)
      expect(metadata.symbol).toBe('USDC')
      expect(metadata.decimals).toBe(7)
      expect(metadata.totalSupply).toBe('10000000000000')
    })

    it('should throw for non-existent asset', async () => {
      globalThis.fetch = mockHorizonResponse({
        _embedded: { records: [] },
      }) as typeof fetch

      await expect(
        provider.getTokenMetadata('FAKE:GBADADDRESSXXX'),
      ).rejects.toThrow('Asset not found')
    })

    it('should throw for invalid token address format', async () => {
      await expect(
        provider.getTokenMetadata('INVALIDFORMAT'),
      ).rejects.toThrow('CODE:ISSUER')
    })
  })

  describe('subscribeBlocks', () => {
    it('should call callback with new ledger numbers', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({
              history_latest_ledger: 100 + callCount,
            }),
          text: () => Promise.resolve(''),
        })
      }) as typeof fetch

      const received: number[] = []
      const unsubscribe = await provider.subscribeBlocks((ledger) => {
        received.push(ledger)
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
      globalThis.fetch = mockHorizonResponse({
        _embedded: { records: [] },
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

  describe('callContract', () => {
    it('should return contract call result', async () => {
      globalThis.fetch = mockHorizonResponse({
        sequence: '12345',
      }) as typeof fetch

      const result = await provider.callContract(
        TEST_ADDRESS,
        'hello',
        ['world'],
      )

      expect(result).toBeDefined()
      expect((result as Record<string, unknown>).contractAddress).toBe(TEST_ADDRESS)
      expect((result as Record<string, unknown>).method).toBe('hello')
    })
  })

  describe('estimateGas', () => {
    it('should return average fee estimate', async () => {
      globalThis.fetch = mockHorizonResponse({
        last_ledger_base_fee: '100',
        last_ledger: '50000000',
        ledger_capacity_usage: '0.5',
        fee_charged: {
          max: '10000',
          min: '100',
          mode: '200',
          p10: '100',
          p20: '100',
          p30: '100',
          p40: '100',
          p50: '100',
          p60: '100',
          p70: '100',
          p80: '200',
          p90: '500',
          p95: '1000',
          p99: '5000',
        },
      }) as typeof fetch

      const gas = await provider.estimateGas(TEST_ADDRESS, 'method')
      expect(gas).toBe('200')
    })
  })
})
