import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HederaRelayProvider } from '../provider.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockRpcResponse(result: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
    text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: 1, result })),
  }
}

function mockRpcError(code: number, message: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, error: { code, message } }),
    text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } })),
  }
}

function mockHttpError(status: number) {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: () => Promise.resolve({}),
    text: () => Promise.resolve('Server Error'),
  }
}

function mockMirrorResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

describe('HederaRelayProvider', () => {
  let provider: HederaRelayProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new HederaRelayProvider({
      relayUrl: 'https://testnet.hashio.io/api',
      mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
    })
  })

  describe('constructor', () => {
    it('should strip trailing slashes from relayUrl', () => {
      const p = new HederaRelayProvider({
        relayUrl: 'https://testnet.hashio.io/api///',
      })
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x0'))
      p.getBalance('0x0000000000000000000000000000000000843b20')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://testnet.hashio.io/api',
        expect.any(Object),
      )
    })
  })

  describe('getBalance', () => {
    it('should return the balance in weibars (18 decimals)', async () => {
      // 100 HBAR = 100 * 10^18 weibars
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x56bc75e2d63100000'))

      const balance = await provider.getBalance('0x0000000000000000000000000000000000843b20')

      expect(balance.address).toBe('0x0000000000000000000000000000000000843b20')
      expect(balance.amount).toBe('100000000000000000000')
      expect(balance.symbol).toBe('HBAR')
      expect(balance.decimals).toBe(18)
    })

    it('should send correct JSON-RPC request', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x0'))

      await provider.getBalance('0x1234567890123456789012345678901234567890')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://testnet.hashio.io/api',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('"method":"eth_getBalance"'),
        }),
      )

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body)
      expect(body.params).toEqual(['0x1234567890123456789012345678901234567890', 'latest'])
    })
  })

  describe('getNonce', () => {
    it('should return the nonce from the relay', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x5'))

      const nonce = await provider.getNonce('0x1234567890123456789012345678901234567890')
      expect(nonce).toBe(5)
    })

    it('should return 0 for a new address', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x0'))

      const nonce = await provider.getNonce('0x0000000000000000000000000000000000000001')
      expect(nonce).toBe(0)
    })
  })

  describe('getTransaction', () => {
    it('should return transaction details', async () => {
      // First call: eth_getTransactionByHash
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          hash: '0xabc123',
          from: '0x1111111111111111111111111111111111111111',
          to: '0x2222222222222222222222222222222222222222',
          value: '0xde0b6b3a7640000',
          blockNumber: '0x1',
          blockHash: '0x' + 'ab'.repeat(32),
          nonce: '0x0',
          gasPrice: '0x1',
          input: '0x',
        }),
      )
      // Second call: eth_getTransactionReceipt
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          status: '0x1',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x1',
        }),
      )
      // Third call: eth_getBlockByHash
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          timestamp: '0x60000000',
        }),
      )

      const tx = await provider.getTransaction('0xabc123')
      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('0xabc123')
      expect(tx!.from).toBe('0x1111111111111111111111111111111111111111')
      expect(tx!.to).toBe('0x2222222222222222222222222222222222222222')
      expect(tx!.status).toBe('confirmed')
    })

    it('should return null for missing transactions', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse(null))

      const tx = await provider.getTransaction('0xnonexistent')
      expect(tx).toBeNull()
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a signed transaction and return tx hash', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0xabc123def456'))

      const txHash = await provider.broadcastTransaction('0xf86c...')
      expect(txHash).toBe('0xabc123def456')
    })

    it('should send the correct RPC method', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0xabc123'))

      await provider.broadcastTransaction('0xdeadbeef')

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body)
      expect(body.method).toBe('eth_sendRawTransaction')
      expect(body.params).toEqual(['0xdeadbeef'])
    })

    it('should throw on RPC error', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcError(-32000, 'nonce too low'))

      await expect(provider.broadcastTransaction('0xbad')).rejects.toThrow('nonce too low')
    })
  })

  describe('estimateFee', () => {
    it('should return gas price from the relay', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0xed7cbcd800'))

      const fee = await provider.estimateFee()
      expect(fee.unit).toBe('weibars')
      expect(BigInt(fee.slow)).toBe(BigInt('0xed7cbcd800'))
      expect(BigInt(fee.average)).toBe(BigInt('0xed7cbcd800'))
      expect(BigInt(fee.fast)).toBeGreaterThan(BigInt(fee.average))
    })
  })

  describe('getChainInfo', () => {
    it('should return Hedera Testnet info', async () => {
      mockFetch
        .mockResolvedValueOnce(mockRpcResponse('0x128')) // eth_chainId = 296
        .mockResolvedValueOnce(mockRpcResponse('0x1234')) // eth_blockNumber

      const info = await provider.getChainInfo()
      expect(info.chainId).toBe('296')
      expect(info.name).toBe('Hedera Testnet')
      expect(info.symbol).toBe('HBAR')
      expect(info.decimals).toBe(18)
      expect(info.testnet).toBe(true)
    })

    it('should return Hedera Mainnet info', async () => {
      mockFetch
        .mockResolvedValueOnce(mockRpcResponse('0x127')) // eth_chainId = 295
        .mockResolvedValueOnce(mockRpcResponse('0x5678'))

      const info = await provider.getChainInfo()
      expect(info.chainId).toBe('295')
      expect(info.name).toBe('Hedera Mainnet')
      expect(info.testnet).toBe(false)
    })
  })

  describe('getBlock', () => {
    it('should return block details by number', async () => {
      mockFetch.mockResolvedValueOnce(
        mockRpcResponse({
          number: '0x64',
          hash: '0x' + 'ab'.repeat(32),
          parentHash: '0x' + 'cd'.repeat(32),
          timestamp: '0x60000000',
          transactions: [],
        }),
      )

      const block = await provider.getBlock(100)
      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.timestamp).toBe(0x60000000)
    })

    it('should return null for non-existent blocks', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse(null))

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('callContract', () => {
    it('should call a contract via eth_call', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0x0000000000000000000000000000000000000001'))

      const result = await provider.callContract(
        '0x1234567890123456789012345678901234567890',
        '0x70a08231',
      )

      expect(result).toBe('0x0000000000000000000000000000000000000001')
    })
  })

  describe('estimateGas', () => {
    it('should estimate gas for a contract call', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcResponse('0xC350'))

      const gas = await provider.estimateGas(
        '0x1234567890123456789012345678901234567890',
        '0x70a08231',
      )

      expect(gas).toBe('50000')
    })
  })

  describe('lookupEvmAddress', () => {
    it('should look up EVM address from mirror node', async () => {
      mockFetch.mockResolvedValueOnce(
        mockMirrorResponse({
          evm_address: '0x0000000000000000000000000000000000843b20',
          alias: 'CIQC5I7JGLSRHG6JE76K5GOI4TCJGWHGYRB6ASEW34ZORQ3EITG4PSA',
        }),
      )

      const evmAddress = await provider.lookupEvmAddress('0.0.8665888')
      expect(evmAddress).toBe('0x0000000000000000000000000000000000843b20')
    })

    it('should return null when account not found', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Not found'))

      const evmAddress = await provider.lookupEvmAddress('0.0.99999999')
      expect(evmAddress).toBeNull()
    })
  })

  describe('getAccountKeyType', () => {
    it('should return key type info from mirror node', async () => {
      mockFetch.mockResolvedValueOnce(
        mockMirrorResponse({
          key: {
            _type: 'ED25519',
            key: '2ea3e932e5139bc927fcae99c8e4c49358e6c443e04896df32e8c36444cdc7c8',
          },
        }),
      )

      const keyInfo = await provider.getAccountKeyType('0.0.8665888')
      expect(keyInfo).not.toBeNull()
      expect(keyInfo!.type).toBe('ED25519')
    })

    it('should return null when account not found', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Not found'))

      const keyInfo = await provider.getAccountKeyType('0.0.99999999')
      expect(keyInfo).toBeNull()
    })
  })

  describe('subscribeBlocks', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse('0x100'))

      const unsub = await provider.subscribeBlocks(() => {})
      expect(typeof unsub).toBe('function')
      unsub()
    })
  })

  describe('subscribeTransactions', () => {
    it('should return an unsubscribe function', async () => {
      mockFetch.mockResolvedValue(mockRpcResponse('0x100'))

      const unsub = await provider.subscribeTransactions(
        '0x1234567890123456789012345678901234567890',
        () => {},
      )
      expect(typeof unsub).toBe('function')
      unsub()
    })
  })

  describe('error handling', () => {
    it('should throw on HTTP errors', async () => {
      mockFetch.mockResolvedValueOnce(mockHttpError(500))

      await expect(provider.getBalance('0x1234567890123456789012345678901234567890')).rejects.toThrow(
        'Relay request failed',
      )
    })

    it('should throw on RPC errors', async () => {
      mockFetch.mockResolvedValueOnce(mockRpcError(-32000, 'internal error'))

      await expect(provider.getBalance('0x1234567890123456789012345678901234567890')).rejects.toThrow(
        'internal error',
      )
    })

    it('should throw on network errors', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))

      await expect(
        provider.getBalance('0x1234567890123456789012345678901234567890'),
      ).rejects.toThrow('Relay request failed')
    })
  })
})
