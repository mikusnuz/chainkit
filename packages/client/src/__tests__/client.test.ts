import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createClient } from '../client.js'
import { createChainInstance } from '../chain-instance.js'
import type { ChainDefinition, FullChainInstance } from '../types.js'

// --- Mock provider and signer ---

function createMockProvider() {
  return {
    getBalance: vi.fn().mockResolvedValue({
      address: '0xaddress',
      amount: '1000000000000000000',
      symbol: 'ETH',
      decimals: 18,
    }),
    getTransaction: vi.fn().mockResolvedValue({
      hash: '0xtxhash',
      from: '0xfrom',
      to: '0xto',
      value: '1000',
      fee: '21000',
      blockNumber: 1,
      blockHash: '0xblockhash',
      status: 'confirmed',
      timestamp: 1700000000,
    }),
    getBlock: vi.fn().mockResolvedValue({
      number: 1,
      hash: '0xblockhash',
      parentHash: '0xparenthash',
      timestamp: 1700000000,
      transactions: ['0xtx1'],
    }),
    estimateFee: vi.fn().mockResolvedValue({
      slow: '10.00',
      average: '15.00',
      fast: '20.00',
      unit: 'gwei',
    }),
    broadcastTransaction: vi.fn().mockResolvedValue('0xtxhash'),
    getChainInfo: vi.fn().mockResolvedValue({
      chainId: '1',
      name: 'Mock Chain',
      symbol: 'MOCK',
      decimals: 18,
      testnet: false,
      blockHeight: 100,
    }),
  }
}

function createMockSigner() {
  return {
    generateMnemonic: vi.fn().mockReturnValue('test mnemonic words here'),
    validateMnemonic: vi.fn().mockReturnValue(true),
    derivePrivateKey: vi.fn().mockResolvedValue('0xderivedprivkey'),
    getAddress: vi.fn().mockReturnValue('0xmockaddress'),
    signTransaction: vi.fn().mockResolvedValue('0xsignedtx'),
    signMessage: vi.fn().mockResolvedValue('0xsig'),
  }
}

function createMockChainDefinition(
  provider: ReturnType<typeof createMockProvider>,
  signer: ReturnType<typeof createMockSigner>,
): ChainDefinition {
  return {
    name: 'mock',
    Signer: vi.fn().mockImplementation(() => signer) as unknown as ChainDefinition['Signer'],
    Provider: vi.fn().mockImplementation(() => provider) as unknown as ChainDefinition['Provider'],
  }
}

describe('createClient', () => {
  let mockProvider: ReturnType<typeof createMockProvider>
  let mockSigner: ReturnType<typeof createMockSigner>
  let mockChain: ChainDefinition

  beforeEach(() => {
    mockProvider = createMockProvider()
    mockSigner = createMockSigner()
    mockChain = createMockChainDefinition(mockProvider, mockSigner)
  })

  it('should create a client with chain access', async () => {
    const client = await createClient({
      chains: {
        ethereum: {
          chain: mockChain,
          rpcs: ['http://localhost:8545'],
          privateKey: '0xprivkey',
        },
      },
    })

    expect(client).toBeDefined()
    expect(client.ethereum).toBeDefined()
    expect(client.ethereum.provider).toBeDefined()
  })

  it('should allow read-only chain to query balance', async () => {
    const client = await createClient({
      chains: {
        ethereum: {
          chain: mockChain,
          rpcs: ['http://localhost:8545'],
        },
      },
    })

    const balance = await client.ethereum.getBalance('0xaddress')
    expect(balance.amount).toBe('1000000000000000000')
    expect(balance.symbol).toBe('ETH')
    expect(mockProvider.getBalance).toHaveBeenCalledWith('0xaddress')
  })

  it('should allow full chain to send transactions', async () => {
    const client = await createClient({
      chains: {
        ethereum: {
          chain: mockChain,
          rpcs: ['http://localhost:8545'],
          privateKey: '0xprivkey',
        },
      },
    })

    const instance = client.ethereum as unknown as FullChainInstance
    const txHash = await instance.send({
      to: '0xrecipient',
      amount: '1000000000000000000',
    })

    expect(txHash).toBe('0xtxhash')
    // Should have estimated fee
    expect(mockProvider.estimateFee).toHaveBeenCalled()
    // Should have signed the transaction
    expect(mockSigner.signTransaction).toHaveBeenCalledWith({
      privateKey: '0xprivkey',
      tx: expect.objectContaining({
        from: '0xmockaddress',
        to: '0xrecipient',
        value: '1000000000000000000',
      }),
    })
    // Should have broadcast the signed transaction
    expect(mockProvider.broadcastTransaction).toHaveBeenCalledWith('0xsignedtx')
  })

  it('should throw on send for read-only chain', async () => {
    const client = await createClient({
      chains: {
        ethereum: {
          chain: mockChain,
          rpcs: ['http://localhost:8545'],
        },
      },
    })

    // Read-only instance should not have send method
    const instance = client.ethereum as Record<string, unknown>
    expect(instance.send).toBeUndefined()
  })

  it('should support mnemonic-based key derivation', async () => {
    const client = await createClient({
      chains: {
        ethereum: {
          chain: mockChain,
          rpcs: ['http://localhost:8545'],
          mnemonic: 'test mnemonic words here',
          hdPath: "m/44'/60'/0'/0/0",
        },
      },
    })

    const instance = client.ethereum as unknown as FullChainInstance

    // derivePrivateKey should have been called with the mnemonic and path
    expect(mockSigner.derivePrivateKey).toHaveBeenCalledWith(
      'test mnemonic words here',
      "m/44'/60'/0'/0/0",
    )

    // The derived key should be used for getAddress
    const address = instance.getAddress()
    expect(address).toBe('0xmockaddress')
    expect(mockSigner.getAddress).toHaveBeenCalledWith('0xderivedprivkey')
  })

  it('should support multiple chains in one client', async () => {
    const mockProvider2 = createMockProvider()
    mockProvider2.getBalance.mockResolvedValue({
      address: '0xbtcaddress',
      amount: '100000000',
      symbol: 'BTC',
      decimals: 8,
    })
    mockProvider2.getChainInfo.mockResolvedValue({
      chainId: 'bitcoin',
      name: 'Bitcoin',
      symbol: 'BTC',
      decimals: 8,
      testnet: false,
    })

    const mockSigner2 = createMockSigner()
    const mockChain2 = createMockChainDefinition(mockProvider2, mockSigner2)

    const client = await createClient({
      chains: {
        ethereum: {
          chain: mockChain,
          rpcs: ['http://localhost:8545'],
          privateKey: '0xethprivkey',
        },
        bitcoin: {
          chain: mockChain2,
          rpcs: ['http://localhost:18332'],
        },
      },
    })

    // Ethereum chain should work
    const ethBalance = await client.ethereum.getBalance('0xethaddr')
    expect(ethBalance.symbol).toBe('ETH')

    // Bitcoin chain should work
    const btcBalance = await client.bitcoin.getBalance('0xbtcaddress')
    expect(btcBalance.symbol).toBe('BTC')

    // Bitcoin is read-only, ethereum has signer
    const ethInstance = client.ethereum as Record<string, unknown>
    const btcInstance = client.bitcoin as Record<string, unknown>
    expect(ethInstance.send).toBeDefined()
    expect(btcInstance.send).toBeUndefined()
  })

  it('should return signer address from getAddress()', async () => {
    const client = await createClient({
      chains: {
        ethereum: {
          chain: mockChain,
          rpcs: ['http://localhost:8545'],
          privateKey: '0xprivkey',
        },
      },
    })

    const instance = client.ethereum as unknown as FullChainInstance
    const address = instance.getAddress()
    expect(address).toBe('0xmockaddress')
    expect(mockSigner.getAddress).toHaveBeenCalledWith('0xprivkey')
  })
})

describe('createChainInstance', () => {
  let mockProvider: ReturnType<typeof createMockProvider>
  let mockSigner: ReturnType<typeof createMockSigner>
  let mockChain: ChainDefinition

  beforeEach(() => {
    mockProvider = createMockProvider()
    mockSigner = createMockSigner()
    mockChain = createMockChainDefinition(mockProvider, mockSigner)
  })

  it('should create a read-only instance without key material', async () => {
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
    })

    expect(instance.provider).toBeDefined()
    expect(instance.getBalance).toBeDefined()
    expect(instance.getTransaction).toBeDefined()
    expect(instance.getBlock).toBeDefined()
    expect(instance.estimateFee).toBeDefined()
    expect(instance.getChainInfo).toBeDefined()

    // Should not have signer methods
    const asRecord = instance as Record<string, unknown>
    expect(asRecord.send).toBeUndefined()
    expect(asRecord.signer).toBeUndefined()
    expect(asRecord.getAddress).toBeUndefined()
  })

  it('should create a full instance with privateKey', async () => {
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
      privateKey: '0xprivkey',
    })

    const full = instance as FullChainInstance
    expect(full.provider).toBeDefined()
    expect(full.signer).toBeDefined()
    expect(full.send).toBeDefined()
    expect(full.getAddress).toBeDefined()
    expect(full.signTransaction).toBeDefined()
    expect(full.signMessage).toBeDefined()
  })

  it('should create a full instance with mnemonic and hdPath', async () => {
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
      mnemonic: 'test mnemonic',
      hdPath: "m/44'/60'/0'/0/0",
    })

    const full = instance as FullChainInstance
    expect(full.signer).toBeDefined()
    expect(full.send).toBeDefined()
    expect(mockSigner.derivePrivateKey).toHaveBeenCalledWith(
      'test mnemonic',
      "m/44'/60'/0'/0/0",
    )
  })

  it('should throw when mnemonic is provided without hdPath', async () => {
    await expect(
      createChainInstance({
        chain: mockChain,
        rpcs: ['http://localhost:8545'],
        mnemonic: 'test mnemonic',
      }),
    ).rejects.toThrow('hdPath is required')
  })

  it('should pass RPC config to provider constructor', async () => {
    await createChainInstance({
      chain: mockChain,
      rpcs: ['http://rpc1.test', 'http://rpc2.test'],
      strategy: 'round-robin',
      timeout: 5000,
      retries: 3,
    })

    expect(mockChain.Provider).toHaveBeenCalledWith({
      endpoints: ['http://rpc1.test', 'http://rpc2.test'],
      strategy: 'round-robin',
      timeout: 5000,
      retries: 3,
    })
  })

  it('should delegate query methods to provider', async () => {
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
    })

    await instance.getBalance('0xaddr')
    expect(mockProvider.getBalance).toHaveBeenCalledWith('0xaddr')

    await instance.getTransaction('0xtxhash')
    expect(mockProvider.getTransaction).toHaveBeenCalledWith('0xtxhash')

    await instance.getBlock(42)
    expect(mockProvider.getBlock).toHaveBeenCalledWith(42)

    await instance.estimateFee()
    expect(mockProvider.estimateFee).toHaveBeenCalled()

    await instance.getChainInfo()
    expect(mockProvider.getChainInfo).toHaveBeenCalled()
  })

  it('should sign and broadcast in send flow', async () => {
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
      privateKey: '0xprivkey',
    }) as FullChainInstance

    const txHash = await instance.send({
      to: '0xrecipient',
      amount: '1000',
      data: '0xdeadbeef',
    })

    // 1. Get address from signer
    expect(mockSigner.getAddress).toHaveBeenCalledWith('0xprivkey')

    // 2. Estimate fee
    expect(mockProvider.estimateFee).toHaveBeenCalled()

    // 3. Sign transaction
    expect(mockSigner.signTransaction).toHaveBeenCalledWith({
      privateKey: '0xprivkey',
      tx: {
        from: '0xmockaddress',
        to: '0xrecipient',
        value: '1000',
        data: '0xdeadbeef',
        fee: { average: '15.00' },
      },
    })

    // 4. Broadcast
    expect(mockProvider.broadcastTransaction).toHaveBeenCalledWith('0xsignedtx')
    expect(txHash).toBe('0xtxhash')
  })
})
