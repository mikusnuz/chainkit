import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PolkadotProvider } from '../provider.js'

// Mock fetch for RPC calls
const mockFetch = vi.fn()
global.fetch = mockFetch

/**
 * Helper to create a successful JSON-RPC response.
 */
function rpcSuccess(result: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', result }),
  }
}

/**
 * Helper to create a sequence of RPC responses.
 */
function setupRpcResponses(responses: unknown[]) {
  for (const result of responses) {
    mockFetch.mockResolvedValueOnce(rpcSuccess(result))
  }
}

describe('PolkadotProvider', () => {
  let provider: PolkadotProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new PolkadotProvider({
      endpoints: ['https://rpc.polkadot.io'],
    })
  })

  describe('constructor', () => {
    it('should create provider with default polkadot network', () => {
      const p = new PolkadotProvider({ endpoints: ['https://rpc.polkadot.io'] })
      expect(p).toBeInstanceOf(PolkadotProvider)
    })

    it('should create provider with kusama network', () => {
      const p = new PolkadotProvider({ endpoints: ['https://kusama-rpc.polkadot.io'] }, 'kusama')
      expect(p).toBeInstanceOf(PolkadotProvider)
    })

    it('should throw with no endpoints', () => {
      expect(() => new PolkadotProvider({ endpoints: [] })).toThrow('At least one RPC endpoint')
    })
  })

  describe('getBalance', () => {
    it('should return balance for a polkadot address', async () => {
      // Mock state_getStorage response with SCALE-encoded AccountInfo
      // nonce(4) + consumers(4) + providers(4) + sufficients(4) = 16 bytes = 32 hex chars
      // free balance u128 LE: 10 DOT = 100_000_000_000 planck = 0x174876E800
      // In LE: 00E876481700000000000000000000000
      const nonce = '01000000' // nonce = 1
      const consumers = '00000000'
      const providers = '01000000'
      const sufficients = '00000000'
      const freeBalance = '00e8764817000000000000000000000000' // 100_000_000_000 in LE u128
      const reserved = '00000000000000000000000000000000'
      const frozen = '00000000000000000000000000000000'

      const accountInfo = '0x' + nonce + consumers + providers + sufficients + freeBalance + reserved + frozen

      setupRpcResponses([accountInfo])

      // Use a valid SS58 address (prefix 0 for Polkadot)
      // We need a real SS58 address for decoding. Generate one from the signer.
      const { PolkadotSigner, POLKADOT_DEFAULT_PATH } = await import('../signer.js')
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        POLKADOT_DEFAULT_PATH,
      )
      const address = signer.getAddress(pk)

      const balance = await provider.getBalance(address)

      expect(balance.address).toBe(address)
      expect(balance.amount).toBe('100000000000')
      expect(balance.symbol).toBe('DOT')
      expect(balance.decimals).toBe(10)
    })

    it('should return 0 balance when storage is null', async () => {
      setupRpcResponses([null])

      const { PolkadotSigner, POLKADOT_DEFAULT_PATH } = await import('../signer.js')
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        POLKADOT_DEFAULT_PATH,
      )
      const address = signer.getAddress(pk)

      const balance = await provider.getBalance(address)

      expect(balance.amount).toBe('0')
      expect(balance.symbol).toBe('DOT')
      expect(balance.decimals).toBe(10)
    })

    it('should use KSM symbol for kusama provider', async () => {
      const kusamaProvider = new PolkadotProvider(
        { endpoints: ['https://kusama-rpc.polkadot.io'] },
        'kusama',
      )

      setupRpcResponses([null])

      const { PolkadotSigner, POLKADOT_DEFAULT_PATH } = await import('../signer.js')
      const signer = new PolkadotSigner('kusama')
      const pk = await signer.derivePrivateKey(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        POLKADOT_DEFAULT_PATH,
      )
      const address = signer.getAddress(pk)

      const balance = await kusamaProvider.getBalance(address)

      expect(balance.symbol).toBe('KSM')
      expect(balance.decimals).toBe(12)
    })
  })

  describe('getBlock', () => {
    it('should get block by number', async () => {
      const blockHash = '0x' + 'ab'.repeat(32)
      const parentHash = '0x' + 'cd'.repeat(32)

      setupRpcResponses([
        // chain_getBlockHash
        blockHash,
        // chain_getBlock
        {
          block: {
            header: {
              number: '0xa',
              parentHash,
            },
            extrinsics: ['0xext1', '0xext2'],
          },
        },
      ])

      const block = await provider.getBlock(10)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(10)
      expect(block!.hash).toBe(blockHash)
      expect(block!.parentHash).toBe(parentHash)
      expect(block!.transactions).toEqual(['0xext1', '0xext2'])
    })

    it('should get block by hash', async () => {
      const blockHash = '0x' + 'ab'.repeat(32)
      const parentHash = '0x' + 'cd'.repeat(32)

      setupRpcResponses([
        // chain_getBlock
        {
          block: {
            header: {
              number: '0x14',
              parentHash,
            },
            extrinsics: [],
          },
        },
      ])

      const block = await provider.getBlock(blockHash)

      expect(block).not.toBeNull()
      expect(block!.number).toBe(20)
      expect(block!.hash).toBe(blockHash)
      expect(block!.parentHash).toBe(parentHash)
    })

    it('should return null for non-existent block', async () => {
      setupRpcResponses([
        // chain_getBlockHash returns empty
        null,
      ])

      // Mock fetch to return RPC error for null block hash
      mockFetch.mockReset()
      mockFetch.mockResolvedValueOnce(rpcSuccess(null))

      const block = await provider.getBlock(999999999)
      expect(block).toBeNull()
    })
  })

  describe('getChainInfo', () => {
    it('should return polkadot chain info', async () => {
      setupRpcResponses([
        // system_chain
        'Polkadot',
        // chain_getHeader
        { number: '0x1000' },
      ])

      const info = await provider.getChainInfo()

      expect(info.chainId).toBe('Polkadot')
      expect(info.name).toBe('Polkadot')
      expect(info.symbol).toBe('DOT')
      expect(info.decimals).toBe(10)
      expect(info.testnet).toBe(false)
      expect(info.blockHeight).toBe(4096)
    })

    it('should detect testnet chains', async () => {
      setupRpcResponses([
        'Westend',
        { number: '0x100' },
      ])

      const info = await provider.getChainInfo()

      expect(info.testnet).toBe(true)
      expect(info.name).toBe('Westend')
    })

    it('should detect development chains', async () => {
      setupRpcResponses([
        'Development',
        { number: '0x1' },
      ])

      const info = await provider.getChainInfo()

      expect(info.testnet).toBe(true)
    })
  })

  describe('estimateFee', () => {
    it('should return fee estimates in planck', async () => {
      const fee = await provider.estimateFee()

      expect(fee.unit).toBe('planck')
      expect(Number(fee.slow)).toBeGreaterThan(0)
      expect(Number(fee.average)).toBeGreaterThanOrEqual(Number(fee.slow))
      expect(Number(fee.fast)).toBeGreaterThanOrEqual(Number(fee.average))
    })
  })

  describe('broadcastTransaction', () => {
    it('should broadcast a signed extrinsic', async () => {
      const txHash = '0x' + 'ef'.repeat(32)
      setupRpcResponses([txHash])

      const result = await provider.broadcastTransaction('0xsigned_extrinsic_data')
      expect(result).toBe(txHash)
    })
  })

  describe('subscribeBlocks', () => {
    it('should return an unsubscribe function', async () => {
      setupRpcResponses([
        { number: '0x1' },
      ])

      let blockReceived = false
      const unsubscribe = await provider.subscribeBlocks((blockNumber) => {
        blockReceived = true
        expect(blockNumber).toBe(1)
      })

      expect(typeof unsubscribe).toBe('function')

      // Wait briefly for the first poll
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Unsubscribe
      unsubscribe()

      expect(blockReceived).toBe(true)
    })
  })

  describe('getTransaction', () => {
    it('should return null for non-existent transaction', async () => {
      setupRpcResponses([
        // chain_getHeader
        { number: '0x1' },
        // chain_getBlockHash
        '0x' + 'ab'.repeat(32),
        // chain_getBlock
        {
          block: {
            header: { number: '0x1', parentHash: '0x' + '00'.repeat(32) },
            extrinsics: [],
          },
        },
      ])

      const tx = await provider.getTransaction('0xnonexistent')
      expect(tx).toBeNull()
    })
  })

  describe('callContract', () => {
    it('should call contracts_call RPC', async () => {
      const contractResult = { success: { data: '0x00', flags: 0 } }
      setupRpcResponses([contractResult])

      const { PolkadotSigner, POLKADOT_DEFAULT_PATH } = await import('../signer.js')
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        POLKADOT_DEFAULT_PATH,
      )
      const address = signer.getAddress(pk)

      const result = await provider.callContract(address, '0xabcdef')
      expect(result).toEqual(contractResult)
    })
  })

  describe('getTokenBalance', () => {
    it('should return 0 balance when storage is empty', async () => {
      setupRpcResponses([null])

      const { PolkadotSigner, POLKADOT_DEFAULT_PATH } = await import('../signer.js')
      const signer = new PolkadotSigner()
      const pk = await signer.derivePrivateKey(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        POLKADOT_DEFAULT_PATH,
      )
      const address = signer.getAddress(pk)

      const balance = await provider.getTokenBalance(address, '1')
      expect(balance.amount).toBe('0')
    })
  })

  describe('getTokenMetadata', () => {
    it('should throw for non-existent asset', async () => {
      setupRpcResponses([null])

      await expect(provider.getTokenMetadata('999')).rejects.toThrow('Asset not found')
    })
  })
})
