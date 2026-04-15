import { describe, it, expect, vi, beforeEach } from 'vitest'
import { XrpProvider } from './provider.js'

// Mock fetch for all provider tests
const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

function mockRpcResponse(result: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result,
    }),
  })
}

function mockRpcError(code: number, message: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      error: { code, message },
    }),
  })
}

describe('XrpProvider', () => {
  let provider: XrpProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new XrpProvider({
      endpoints: ['https://s1.ripple.com:51234/'],
    })
  })

  describe('getBalance', () => {
    it('should return the balance in drops', async () => {
      mockRpcResponse({
        account_data: {
          Account: 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6KQu',
          Balance: '50000000',
        },
      })

      const balance = await provider.getBalance('rN7n3473SaZBCG4dFL83w7p1W9cgZw6KQu')

      expect(balance.address).toBe('rN7n3473SaZBCG4dFL83w7p1W9cgZw6KQu')
      expect(balance.amount).toBe('50000000')
      expect(balance.symbol).toBe('XRP')
      expect(balance.decimals).toBe(6)
    })

    it('should send correct rippled JSON-RPC request', async () => {
      mockRpcResponse({
        account_data: {
          Account: 'rTestAddr',
          Balance: '100000',
        },
      })

      await provider.getBalance('rTestAddr')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.method).toBe('account_info')
      expect(body.params).toEqual([{ account: 'rTestAddr', ledger_index: 'validated' }])
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info for a valid hash', async () => {
      mockRpcResponse({
        Account: 'rSender123',
        Destination: 'rDest456',
        Amount: '1000000',
        Fee: '12',
        Sequence: 42,
        hash: 'ABCDEF1234567890',
        inLedger: 50000000,
        date: 750000000,
        meta: {
          TransactionResult: 'tesSUCCESS',
        },
        validated: true,
      })

      const tx = await provider.getTransaction('ABCDEF1234567890')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('ABCDEF1234567890')
      expect(tx!.from).toBe('rSender123')
      expect(tx!.to).toBe('rDest456')
      expect(tx!.value).toBe('1000000')
      expect(tx!.fee).toBe('12')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(50000000)
      expect(tx!.nonce).toBe(42)
      // XRP epoch: 946684800 + 750000000 = 1696684800
      expect(tx!.timestamp).toBe(946684800 + 750000000)
    })

    it('should return null for unknown transaction', async () => {
      mockRpcError(-1, 'Transaction not found')

      const tx = await provider.getTransaction('NONEXISTENT')
      expect(tx).toBeNull()
    })

    it('should handle failed transactions', async () => {
      mockRpcResponse({
        Account: 'rSender123',
        Destination: 'rDest456',
        Amount: '1000000',
        Fee: '12',
        Sequence: 10,
        hash: 'FAILED123',
        inLedger: 50000001,
        date: 750000100,
        meta: {
          TransactionResult: 'tecUNFUNDED_PAYMENT',
        },
        validated: true,
      })

      const tx = await provider.getTransaction('FAILED123')
      expect(tx!.status).toBe('failed')
    })

    it('should handle pending transactions', async () => {
      mockRpcResponse({
        Account: 'rSender123',
        Destination: 'rDest456',
        Amount: '500000',
        Fee: '12',
        Sequence: 5,
        hash: 'PENDING123',
        validated: false,
      })

      const tx = await provider.getTransaction('PENDING123')
      expect(tx!.status).toBe('pending')
      expect(tx!.blockNumber).toBeNull()
    })

    it('should handle IOU amounts (object format)', async () => {
      mockRpcResponse({
        Account: 'rSender123',
        Destination: 'rDest456',
        Amount: { value: '100.50', currency: 'USD', issuer: 'rIssuer789' },
        Fee: '12',
        Sequence: 3,
        hash: 'IOU123',
        validated: true,
        meta: { TransactionResult: 'tesSUCCESS' },
      })

      const tx = await provider.getTransaction('IOU123')
      expect(tx!.value).toBe('100.50')
    })
  })

  describe('getBlock', () => {
    it('should return ledger info by index (number)', async () => {
      mockRpcResponse({
        ledger: {
          ledger_index: 50000000,
          ledger_hash: 'LEDGERHASH123',
          parent_hash: 'PARENTHASH456',
          close_time: 750000000,
          transactions: ['TX1', 'TX2'],
        },
      })

      const block = await provider.getBlock(50000000)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(50000000)
      expect(block!.hash).toBe('LEDGERHASH123')
      expect(block!.parentHash).toBe('PARENTHASH456')
      expect(block!.timestamp).toBe(946684800 + 750000000)
      expect(block!.transactions).toEqual(['TX1', 'TX2'])
    })

    it('should handle string number index', async () => {
      mockRpcResponse({
        ledger: {
          ledger_index: 123456,
          ledger_hash: 'HASH',
          parent_hash: 'PARENT',
          close_time: 0,
          transactions: [],
        },
      })

      const block = await provider.getBlock('123456')
      expect(block!.number).toBe(123456)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.params[0].ledger_index).toBe(123456)
    })

    it('should handle hash string', async () => {
      mockRpcResponse({
        ledger: {
          ledger_index: 99999,
          ledger_hash: 'SOMEHASH',
          parent_hash: 'PARENT',
          close_time: 100,
          transactions: [],
        },
      })

      await provider.getBlock('SOMEHASH')

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.params[0].ledger_hash).toBe('SOMEHASH')
    })

    it('should return null for non-existent ledger', async () => {
      mockRpcError(-1, 'Ledger not found')

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates in drops', async () => {
      mockRpcResponse({
        drops: {
          minimum_fee: '10',
          median_fee: '5000',
          open_ledger_fee: '12000',
        },
      })

      const fee = await provider.estimateFee()

      expect(fee.slow).toBe('10')
      expect(fee.average).toBe('5000')
      expect(fee.fast).toBe('12000')
      expect(fee.unit).toBe('drops')
    })
  })

  describe('broadcastTransaction', () => {
    it('should return the transaction hash on success', async () => {
      mockRpcResponse({
        tx_json: { hash: 'TXHASH123' },
        engine_result: 'tesSUCCESS',
        engine_result_message: 'The transaction was applied.',
      })

      const hash = await provider.broadcastTransaction('0xABCDEF')
      expect(hash).toBe('TXHASH123')
    })

    it('should accept queued transactions', async () => {
      mockRpcResponse({
        tx_json: { hash: 'TXHASH456' },
        engine_result: 'terQUEUED',
        engine_result_message: 'Held until escalated fee drops.',
      })

      const hash = await provider.broadcastTransaction('0xFEDCBA')
      expect(hash).toBe('TXHASH456')
    })

    it('should throw on failed submission', async () => {
      mockRpcResponse({
        tx_json: { hash: 'FAILED' },
        engine_result: 'temBAD_AMOUNT',
        engine_result_message: 'Can only send positive amounts.',
      })

      await expect(provider.broadcastTransaction('0xBAD')).rejects.toThrow(
        'Transaction submission failed',
      )
    })

    it('should throw on error response without engine_result', async () => {
      mockRpcResponse({
        tx_json: { hash: 'ERRHASH' },
        error: 'invalidTransaction',
      })

      await expect(provider.broadcastTransaction('0xBAD')).rejects.toThrow(
        'Transaction submission failed',
      )
    })

    it('should strip 0x prefix from tx blob', async () => {
      mockRpcResponse({
        tx_json: { hash: 'HASH' },
        engine_result: 'tesSUCCESS',
        engine_result_message: 'OK',
      })

      await provider.broadcastTransaction('0xABCDEF')

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.params[0].tx_blob).toBe('ABCDEF')
    })
  })

  describe('getChainInfo', () => {
    it('should return mainnet info when no network_id', async () => {
      mockRpcResponse({
        info: {
          build_version: '1.9.4',
          complete_ledgers: '32570-75000000',
          hostid: 'test',
          server_state: 'full',
          validated_ledger: { seq: 75000000 },
        },
      })

      const info = await provider.getChainInfo()

      expect(info.name).toBe('XRP Ledger')
      expect(info.symbol).toBe('XRP')
      expect(info.decimals).toBe(6)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(75000000)
    })

    it('should detect testnet by network_id', async () => {
      mockRpcResponse({
        info: {
          build_version: '1.9.4',
          complete_ledgers: '1-1000',
          hostid: 'test',
          server_state: 'full',
          validated_ledger: { seq: 1000 },
          network_id: 1,
        },
      })

      const info = await provider.getChainInfo()

      expect(info.testnet).toBe(true)
      expect(info.chainId).toBe('1')
      expect(info.name).toBe('XRP Ledger Testnet')
    })
  })

  describe('getTokenBalance', () => {
    it('should return trustline token balance', async () => {
      mockRpcResponse({
        lines: [
          {
            account: 'rIssuer789',
            balance: '150.25',
            currency: 'USD',
            limit: '10000',
            limit_peer: '0',
          },
        ],
      })

      const balance = await provider.getTokenBalance(
        'rHolder123',
        'USD:rIssuer789',
      )

      expect(balance.amount).toBe('150.25')
      expect(balance.symbol).toBe('USD')
      expect(balance.decimals).toBe(15)
    })

    it('should return zero for non-existent trustline', async () => {
      mockRpcResponse({ lines: [] })

      const balance = await provider.getTokenBalance(
        'rHolder123',
        'EUR:rIssuer789',
      )

      expect(balance.amount).toBe('0')
      expect(balance.symbol).toBe('EUR')
    })

    it('should throw for invalid token address format', async () => {
      await expect(
        provider.getTokenBalance('rHolder123', 'INVALID_FORMAT'),
      ).rejects.toThrow('Token address must be in "CURRENCY:ISSUER" format')
    })
  })

  describe('getTokenMetadata', () => {
    it('should return metadata derived from currency code', async () => {
      const metadata = await provider.getTokenMetadata('USD:rIssuer789')

      expect(metadata.name).toBe('USD')
      expect(metadata.symbol).toBe('USD')
      expect(metadata.decimals).toBe(15)
      expect(metadata.address).toBe('USD:rIssuer789')
    })

    it('should throw for invalid token address format', async () => {
      await expect(provider.getTokenMetadata('INVALID')).rejects.toThrow(
        'Token address must be in "CURRENCY:ISSUER" format',
      )
    })
  })

  describe('subscribeBlocks', () => {
    it('should call callback with new ledger index', async () => {
      // First call returns ledger 100
      mockRpcResponse({
        info: { validated_ledger: { seq: 100 } },
      })

      const received: number[] = []
      const unsub = await provider.subscribeBlocks((n) => received.push(n))

      // Wait for first poll
      await new Promise((r) => setTimeout(r, 50))

      expect(received).toContain(100)

      // Cleanup
      unsub()
    })

    it('should return an unsubscribe function', async () => {
      mockRpcResponse({
        info: { validated_ledger: { seq: 1 } },
      })

      const unsub = await provider.subscribeBlocks(() => {})
      expect(typeof unsub).toBe('function')
      unsub()
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      // server_info for init
      mockRpcResponse({
        info: { validated_ledger: { seq: 100 } },
      })

      const unsub = await provider.subscribeTransactions('rAddr123', () => {})
      expect(typeof unsub).toBe('function')
      unsub()
    })
  })
})
