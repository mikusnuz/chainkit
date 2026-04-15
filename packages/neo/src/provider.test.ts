import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NeoProvider } from './provider.js'

/**
 * Mock fetch globally for provider tests.
 * Neo N3 uses JSON-RPC so we mock the fetch responses.
 */

function createMockFetch(handler: (method: string, params: unknown[]) => unknown) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string)
    const result = handler(body.method, body.params ?? [])

    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  })
}

describe('NeoProvider', () => {
  let provider: NeoProvider

  beforeEach(() => {
    provider = new NeoProvider({
      endpoints: ['https://testnet1.neo.coz.io:443'],
    })
  })

  describe('constructor', () => {
    it('should create a provider with valid config', () => {
      expect(provider).toBeInstanceOf(NeoProvider)
    })

    it('should throw with empty endpoints', () => {
      expect(() => new NeoProvider({ endpoints: [] })).toThrow(
        'At least one RPC endpoint is required',
      )
    })
  })

  describe('getBalance', () => {
    it('should return GAS balance for an address', async () => {
      const mockFetch = createMockFetch((method) => {
        if (method === 'getnep17balances') {
          return {
            address: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
            balance: [
              {
                assethash: '0xcf76e28bd0062c4a478ee355610113f3cfa4d2', // truncated for test
                amount: '100000000',
                lastupdatedblock: 12345,
              },
              {
                assethash: '0xd2a4cff31913016155e38e474a2c06d08be276cf',
                amount: '500000000',
                lastupdatedblock: 12345,
              },
            ],
          }
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const balance = await provider.getBalance('NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs')

      expect(balance.address).toBe('NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs')
      expect(balance.symbol).toBe('GAS')
      expect(balance.decimals).toBe(8)
      expect(typeof balance.amount).toBe('string')

      vi.unstubAllGlobals()
    })

    it('should return zero balance when no tokens found', async () => {
      const mockFetch = createMockFetch((method) => {
        if (method === 'getnep17balances') {
          return {
            address: 'NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs',
            balance: [],
          }
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const balance = await provider.getBalance('NNLi44dJNXtDNSBkofB48aTVYtb1zZrNEs')
      expect(balance.amount).toBe('0')

      vi.unstubAllGlobals()
    })
  })

  describe('getBlock', () => {
    it('should return block info by number', async () => {
      const mockFetch = createMockFetch((method, params) => {
        if (method === 'getblock') {
          return {
            hash: '0xabc123',
            index: params[0],
            previousblockhash: '0xdef456',
            time: 1700000000,
            tx: [
              { hash: '0xtx1' },
              { hash: '0xtx2' },
            ],
          }
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const block = await provider.getBlock(100)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)
      expect(block!.hash).toBe('0xabc123')
      expect(block!.parentHash).toBe('0xdef456')
      expect(block!.transactions).toHaveLength(2)

      vi.unstubAllGlobals()
    })

    it('should return block info by hash', async () => {
      const mockFetch = createMockFetch((method) => {
        if (method === 'getblock') {
          return {
            hash: '0xabc123',
            index: 100,
            previousblockhash: '0xdef456',
            time: 1700000000,
            tx: [],
          }
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const block = await provider.getBlock('0xabc123')

      expect(block).not.toBeNull()
      expect(block!.number).toBe(100)

      vi.unstubAllGlobals()
    })

    it('should return null for RPC error', async () => {
      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string)
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -100, message: 'Unknown block' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      })

      vi.stubGlobal('fetch', mockFetch)

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()

      vi.unstubAllGlobals()
    })
  })

  describe('getTransaction', () => {
    it('should return transaction info', async () => {
      const mockFetch = createMockFetch((method) => {
        if (method === 'getrawtransaction') {
          return {
            hash: '0xtxhash123',
            blockhash: '0xblockhash123',
            sysfee: '0.1',
            netfee: '0.05',
            nonce: 42,
            script: 'abc123',
            signers: [{ account: '0xsenderaccount' }],
          }
        }
        if (method === 'getapplicationlog') {
          return {
            executions: [{ vmstate: 'HALT' }],
          }
        }
        if (method === 'getblock') {
          return {
            index: 500,
            time: 1700000000,
          }
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const tx = await provider.getTransaction('0xtxhash123')

      expect(tx).not.toBeNull()
      expect(tx!.hash).toBe('0xtxhash123')
      expect(tx!.status).toBe('confirmed')
      expect(tx!.blockNumber).toBe(500)

      vi.unstubAllGlobals()
    })

    it('should return null for missing transaction', async () => {
      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string)
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -100, message: 'Unknown transaction' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      })

      vi.stubGlobal('fetch', mockFetch)

      const tx = await provider.getTransaction('0xnonexistent')
      expect(tx).toBeNull()

      vi.unstubAllGlobals()
    })
  })

  describe('getChainInfo', () => {
    it('should return chain information', async () => {
      const mockFetch = createMockFetch((method) => {
        if (method === 'getversion') {
          return {
            network: 860833102,
            neoversion: '3.6.0',
          }
        }
        if (method === 'getblockcount') {
          return 5000001
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('860833102')
      expect(info.symbol).toBe('NEO')
      expect(info.decimals).toBe(0)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(5000000)
      expect(info.name).toContain('Neo N3')

      vi.unstubAllGlobals()
    })

    it('should detect testnet', async () => {
      const mockFetch = createMockFetch((method) => {
        if (method === 'getversion') {
          return {
            network: 894710606,
            neoversion: '3.6.0',
          }
        }
        if (method === 'getblockcount') {
          return 1000
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const info = await provider.getChainInfo()

      expect(info.testnet).toBe(true)
      expect(info.name).toContain('Testnet')

      vi.unstubAllGlobals()
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates in GAS', async () => {
      const mockFetch = createMockFetch(() => {
        return { state: 'HALT', stack: [] }
      })

      vi.stubGlobal('fetch', mockFetch)

      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('GAS')
      expect(parseFloat(fee.slow)).toBeGreaterThan(0)
      expect(parseFloat(fee.average)).toBeGreaterThan(0)
      expect(parseFloat(fee.fast)).toBeGreaterThan(0)
      expect(parseFloat(fee.slow)).toBeLessThanOrEqual(parseFloat(fee.average))
      expect(parseFloat(fee.average)).toBeLessThanOrEqual(parseFloat(fee.fast))

      vi.unstubAllGlobals()
    })
  })

  describe('broadcastTransaction', () => {
    it('should return transaction hash on success', async () => {
      const mockFetch = createMockFetch((method) => {
        if (method === 'sendrawtransaction') {
          return { hash: '0xnewtxhash' }
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const hash = await provider.broadcastTransaction('0xsignedtxdata')
      expect(hash).toBe('0xnewtxhash')

      vi.unstubAllGlobals()
    })
  })

  describe('callContract', () => {
    it('should call a contract method and return stack result', async () => {
      const mockFetch = createMockFetch((method) => {
        if (method === 'invokefunction') {
          return {
            state: 'HALT',
            stack: [{ type: 'Integer', value: '100000000' }],
            gasconsumed: '2000000',
          }
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const result = await provider.callContract(
        '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
        'totalSupply',
      )

      expect(result).toEqual({ type: 'Integer', value: '100000000' })

      vi.unstubAllGlobals()
    })
  })

  describe('estimateGas', () => {
    it('should return gas consumed', async () => {
      const mockFetch = createMockFetch((method) => {
        if (method === 'invokefunction') {
          return {
            state: 'HALT',
            stack: [],
            gasconsumed: '1500000',
          }
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const gas = await provider.estimateGas(
        '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
        'transfer',
      )

      expect(gas).toBe('1500000')

      vi.unstubAllGlobals()
    })
  })

  describe('getTokenBalance', () => {
    it('should return NEP-17 token balance', async () => {
      const mockFetch = createMockFetch((method, params) => {
        if (method === 'invokefunction') {
          const funcName = params[1] as string
          if (funcName === 'balanceOf') {
            return {
              state: 'HALT',
              stack: [{ type: 'Integer', value: '50000000' }],
            }
          }
          if (funcName === 'decimals') {
            return {
              state: 'HALT',
              stack: [{ type: 'Integer', value: '8' }],
            }
          }
          if (funcName === 'symbol') {
            return {
              state: 'HALT',
              stack: [{ type: 'ByteString', value: btoa('GAS') }],
            }
          }
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const balance = await provider.getTokenBalance(
        '0xabcdef1234567890abcdef1234567890abcdef12',
        '0xd2a4cff31913016155e38e474a2c06d08be276cf',
      )

      expect(balance.amount).toBe('50000000')
      expect(balance.decimals).toBe(8)
      expect(balance.symbol).toBe('GAS')

      vi.unstubAllGlobals()
    })
  })

  describe('getTokenMetadata', () => {
    it('should return NEP-17 token metadata', async () => {
      const mockFetch = createMockFetch((method, params) => {
        if (method === 'invokefunction') {
          const funcName = params[1] as string
          if (funcName === 'symbol') {
            return {
              state: 'HALT',
              stack: [{ type: 'ByteString', value: btoa('NEO') }],
            }
          }
          if (funcName === 'decimals') {
            return {
              state: 'HALT',
              stack: [{ type: 'Integer', value: '0' }],
            }
          }
          if (funcName === 'totalSupply') {
            return {
              state: 'HALT',
              stack: [{ type: 'Integer', value: '100000000' }],
            }
          }
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)

      const metadata = await provider.getTokenMetadata(
        '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      )

      expect(metadata.symbol).toBe('NEO')
      expect(metadata.decimals).toBe(0)
      expect(metadata.totalSupply).toBe('100000000')

      vi.unstubAllGlobals()
    })
  })

  describe('subscribeBlocks', () => {
    it('should call callback on new blocks and allow unsubscribe', async () => {
      let callCount = 0
      let blockCountResponse = 100

      const mockFetch = createMockFetch((method) => {
        if (method === 'getblockcount') {
          callCount++
          if (callCount <= 2) {
            return blockCountResponse++
          }
          return blockCountResponse
        }
        return null
      })

      vi.stubGlobal('fetch', mockFetch)
      vi.useFakeTimers()

      const blocks: number[] = []
      const unsub = await provider.subscribeBlocks((blockNumber) => {
        blocks.push(blockNumber)
      })

      // Wait for first poll
      await vi.advanceTimersByTimeAsync(100)
      expect(blocks.length).toBeGreaterThanOrEqual(1)

      // Unsubscribe
      unsub()

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })
  })
})
