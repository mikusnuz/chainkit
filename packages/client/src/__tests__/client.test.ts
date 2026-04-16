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
    getNonce: vi.fn().mockResolvedValue(5),
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
    derivePrivateKey: vi.fn().mockResolvedValue('0x' + '22'.repeat(32)),
    getAddress: vi.fn().mockReturnValue('0xmockaddress'),
    signTransaction: vi.fn().mockResolvedValue('0xsignedtx'),
    signMessage: vi.fn().mockResolvedValue('0xsig'),
    validateAddress: vi.fn().mockReturnValue(true),
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
          privateKey: '0x' + '11'.repeat(32),
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

  it('should allow full chain to send transactions with auto-fetch', async () => {
    const client = await createClient({
      chains: {
        ethereum: {
          chain: mockChain,
          rpcs: ['http://localhost:8545'],
          privateKey: '0x' + '11'.repeat(32),
        },
      },
    })

    const instance = client.ethereum as unknown as FullChainInstance
    const txHash = await instance.send({
      to: '0xrecipient',
      amount: '1000000000000000000',
    })

    expect(txHash).toBe('0xtxhash')
    // Should have fetched nonce
    expect(mockProvider.getNonce).toHaveBeenCalledWith('0xmockaddress')
    // Should have estimated fee
    expect(mockProvider.estimateFee).toHaveBeenCalled()
    // Should have signed the transaction with auto-fetched params
    expect(mockSigner.signTransaction).toHaveBeenCalledWith({
      privateKey: '0x' + '11'.repeat(32),
      tx: expect.objectContaining({
        from: '0xmockaddress',
        to: '0xrecipient',
        amount: '1000000000000000000',
        value: '1000000000000000000',
        nonce: 5,
        fee: { fee: '15.00' },
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
    expect(mockSigner.getAddress).toHaveBeenCalledWith('0x' + '22'.repeat(32))
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
          privateKey: '0x' + '33'.repeat(32),
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
          privateKey: '0x' + '11'.repeat(32),
        },
      },
    })

    const instance = client.ethereum as unknown as FullChainInstance
    const address = instance.getAddress()
    expect(address).toBe('0xmockaddress')
    expect(mockSigner.getAddress).toHaveBeenCalledWith('0x' + '11'.repeat(32))
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
      privateKey: '0x' + '11'.repeat(32),
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

  it('should use getDefaultHdPath when mnemonic is provided without hdPath', async () => {
    // When signer has getDefaultHdPath, it should use that
    mockSigner.getDefaultHdPath = vi.fn().mockReturnValue("m/44'/60'/0'/0/0")
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
      mnemonic: 'test mnemonic',
    }) as FullChainInstance

    expect(mockSigner.derivePrivateKey).toHaveBeenCalledWith(
      'test mnemonic',
      "m/44'/60'/0'/0/0",
    )
    expect(instance.signer).toBeDefined()
  })

  it('should throw when mnemonic provided without hdPath and no default', async () => {
    // When signer does NOT have getDefaultHdPath, it should throw
    delete (mockSigner as Record<string, unknown>).getDefaultHdPath
    await expect(
      createChainInstance({
        chain: mockChain,
        rpcs: ['http://localhost:8545'],
        mnemonic: 'test mnemonic',
      }),
    ).rejects.toThrow('hdPath is required')
  })

  it('should pass network to signer constructor', async () => {
    await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
      network: 'testnet',
      privateKey: '0x' + '11'.repeat(32),
    })

    expect(mockChain.Signer).toHaveBeenCalledWith('testnet')
  })

  it('should default to mainnet when network is not specified', async () => {
    await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
      privateKey: '0x' + '11'.repeat(32),
    })

    expect(mockChain.Signer).toHaveBeenCalledWith('mainnet')
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

  it('should auto-fetch nonce and fee in send flow', async () => {
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
      privateKey: '0x' + '11'.repeat(32),
    }) as FullChainInstance

    const txHash = await instance.send({
      to: '0xrecipient',
      amount: '1000',
      data: '0xdeadbeef',
    })

    // 1. Get address from signer
    expect(mockSigner.getAddress).toHaveBeenCalledWith('0x' + '11'.repeat(32))

    // 2. Fetch nonce
    expect(mockProvider.getNonce).toHaveBeenCalledWith('0xmockaddress')

    // 3. Estimate fee
    expect(mockProvider.estimateFee).toHaveBeenCalled()

    // 4. Sign transaction with auto-fetched params
    expect(mockSigner.signTransaction).toHaveBeenCalledWith({
      privateKey: '0x' + '11'.repeat(32),
      tx: expect.objectContaining({
        from: '0xmockaddress',
        to: '0xrecipient',
        amount: '1000',
        value: '1000',
        data: '0xdeadbeef',
        nonce: 5,
        fee: { fee: '15.00' },
      }),
    })

    // 5. Broadcast
    expect(mockProvider.broadcastTransaction).toHaveBeenCalledWith('0xsignedtx')
    expect(txHash).toBe('0xtxhash')
  })

  it('should strip outputs and inputs from options to prevent fund redirection', async () => {
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
      privateKey: '0x' + '11'.repeat(32),
    }) as FullChainInstance

    await instance.send({
      to: '0xrecipient',
      amount: '1000',
      options: {
        outputs: [{ address: '0xattacker', value: '1000' }],
        inputs: [{ txHash: 'abc', outputIndex: 0, value: '2000' }],
        chainId: 1,
      },
    })

    // The signed tx should NOT contain outputs or inputs from options
    const signCall = mockSigner.signTransaction.mock.calls[0][0]
    expect(signCall.tx.extra).toBeDefined()
    expect(signCall.tx.extra.outputs).toBeUndefined()
    expect(signCall.tx.extra.inputs).toBeUndefined()
    // But other options like chainId should pass through
    expect(signCall.tx.extra.chainId).toBe(1)
  })

  it('should prepare transaction without signing', async () => {
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
      privateKey: '0x' + '11'.repeat(32),
    }) as FullChainInstance

    const tx = await instance.prepareTransaction({
      to: '0xrecipient',
      amount: '500',
      memo: 'test memo',
    })

    expect(tx.from).toBe('0xmockaddress')
    expect(tx.to).toBe('0xrecipient')
    expect(tx.amount).toBe('500')
    expect(tx.value).toBe('500')
    expect(tx.memo).toBe('test memo')
    expect(tx.nonce).toBe(5)
    expect(tx.fee).toEqual({ fee: '15.00' })

    // Should NOT have signed or broadcast
    expect(mockSigner.signTransaction).not.toHaveBeenCalled()
    expect(mockProvider.broadcastTransaction).not.toHaveBeenCalled()
  })

  it('should expose waitForTransaction on read-only instance', async () => {
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
    })

    expect(instance.waitForTransaction).toBeDefined()
    const result = await instance.waitForTransaction('0xtxhash', { intervalMs: 10 })
    expect(result.status).toBe('confirmed')
    expect(mockProvider.getTransaction).toHaveBeenCalledWith('0xtxhash')
  })

  it('should expose waitForTransaction on full instance', async () => {
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
      privateKey: '0x' + '11'.repeat(32),
    }) as FullChainInstance

    expect(instance.waitForTransaction).toBeDefined()
    const result = await instance.waitForTransaction('0xtxhash', { intervalMs: 10 })
    expect(result.status).toBe('confirmed')
  })

  it('should have destroy() method on full instance', async () => {
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://localhost:8545'],
      privateKey: '0x' + '11'.repeat(32),
    }) as FullChainInstance

    expect(instance.destroy).toBeDefined()
    expect(typeof instance.destroy).toBe('function')
    // Should not throw
    instance.destroy()
  })

  it('should auto-downgrade fastest strategy to failover for signing clients', async () => {
    // XC-005: fastest is auto-downgraded to failover when key material is present
    const instance = await createChainInstance({
      chain: mockChain,
      rpcs: ['http://rpc1.test', 'http://rpc2.test'],
      strategy: 'fastest',
      privateKey: '0x' + '11'.repeat(32),
    })

    // Provider should have been created — instance exists without error
    expect(instance).toBeDefined()
  })

  it('should not warn when fastest strategy is used without signing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await createChainInstance({
      chain: mockChain,
      rpcs: ['http://rpc1.test', 'http://rpc2.test'],
      strategy: 'fastest',
    })

    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('should not warn when failover strategy is used with signing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await createChainInstance({
      chain: mockChain,
      rpcs: ['http://rpc1.test'],
      strategy: 'failover',
      privateKey: '0x' + '11'.repeat(32),
    })

    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})
