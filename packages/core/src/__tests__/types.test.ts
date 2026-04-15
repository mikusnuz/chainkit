import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  ChainKitError,
  ErrorCode,
} from '../types/index.js'
import type {
  Address,
  TxHash,
  HexString,
  Balance,
  TransactionInfo,
  BlockInfo,
  ChainInfo,
  TokenMetadata,
  Utxo,
  UnsignedTx,
  LegacyUnsignedTx,
  SendParams,
  Unsubscribe,
  ChainSigner,
  LegacyChainSigner,
  SignTransactionParams,
  SignMessageParams,
  ChainProvider,
  FeeEstimate,
  EndpointStrategy,
  EndpointConfig,
  EndpointInput,
  ProviderConfig,
  ContractCapable,
  TokenCapable,
  SubscriptionCapable,
  UtxoCapable,
} from '../types/index.js'

describe('Common types', () => {
  it('Address, TxHash, HexString should be string aliases', () => {
    expectTypeOf<Address>().toBeString()
    expectTypeOf<TxHash>().toBeString()
    expectTypeOf<HexString>().toBeString()
  })

  it('Balance should have correct shape', () => {
    expectTypeOf<Balance>().toHaveProperty('address')
    expectTypeOf<Balance>().toHaveProperty('amount')
    expectTypeOf<Balance>().toHaveProperty('symbol')
    expectTypeOf<Balance>().toHaveProperty('decimals')

    expectTypeOf<Balance['address']>().toBeString()
    expectTypeOf<Balance['amount']>().toBeString()
    expectTypeOf<Balance['symbol']>().toBeString()
    expectTypeOf<Balance['decimals']>().toBeNumber()
  })

  it('TransactionInfo should have correct shape', () => {
    expectTypeOf<TransactionInfo>().toHaveProperty('hash')
    expectTypeOf<TransactionInfo>().toHaveProperty('from')
    expectTypeOf<TransactionInfo>().toHaveProperty('to')
    expectTypeOf<TransactionInfo>().toHaveProperty('value')
    expectTypeOf<TransactionInfo>().toHaveProperty('fee')
    expectTypeOf<TransactionInfo>().toHaveProperty('blockNumber')
    expectTypeOf<TransactionInfo>().toHaveProperty('status')
    expectTypeOf<TransactionInfo>().toHaveProperty('timestamp')

    expectTypeOf<TransactionInfo['status']>().toEqualTypeOf<'pending' | 'confirmed' | 'failed'>()
    expectTypeOf<TransactionInfo['to']>().toEqualTypeOf<string | null>()
    expectTypeOf<TransactionInfo['blockNumber']>().toEqualTypeOf<number | null>()
  })

  it('BlockInfo should have correct shape', () => {
    expectTypeOf<BlockInfo>().toHaveProperty('number')
    expectTypeOf<BlockInfo>().toHaveProperty('hash')
    expectTypeOf<BlockInfo>().toHaveProperty('parentHash')
    expectTypeOf<BlockInfo>().toHaveProperty('timestamp')
    expectTypeOf<BlockInfo>().toHaveProperty('transactions')

    expectTypeOf<BlockInfo['number']>().toBeNumber()
    expectTypeOf<BlockInfo['transactions']>().toEqualTypeOf<string[]>()
  })

  it('ChainInfo should have correct shape', () => {
    expectTypeOf<ChainInfo>().toHaveProperty('chainId')
    expectTypeOf<ChainInfo>().toHaveProperty('name')
    expectTypeOf<ChainInfo>().toHaveProperty('symbol')
    expectTypeOf<ChainInfo>().toHaveProperty('decimals')
    expectTypeOf<ChainInfo>().toHaveProperty('testnet')
  })

  it('TokenMetadata should have correct shape', () => {
    expectTypeOf<TokenMetadata>().toHaveProperty('address')
    expectTypeOf<TokenMetadata>().toHaveProperty('name')
    expectTypeOf<TokenMetadata>().toHaveProperty('symbol')
    expectTypeOf<TokenMetadata>().toHaveProperty('decimals')
  })

  it('Utxo should have correct shape', () => {
    expectTypeOf<Utxo>().toHaveProperty('txHash')
    expectTypeOf<Utxo>().toHaveProperty('outputIndex')
    expectTypeOf<Utxo>().toHaveProperty('amount')
    expectTypeOf<Utxo>().toHaveProperty('script')
    expectTypeOf<Utxo>().toHaveProperty('confirmed')

    expectTypeOf<Utxo['outputIndex']>().toBeNumber()
    expectTypeOf<Utxo['confirmed']>().toBeBoolean()
  })

  it('UnsignedTx should have correct shape with optional from', () => {
    expectTypeOf<UnsignedTx>().toHaveProperty('to')
    expectTypeOf<UnsignedTx>().toHaveProperty('extra')

    // from is now optional
    const tx: UnsignedTx = { to: '0x123' }
    expectTypeOf(tx).toMatchTypeOf<UnsignedTx>()

    // amount and value are both optional
    const txWithAmount: UnsignedTx = { to: '0x123', amount: '1000' }
    expectTypeOf(txWithAmount).toMatchTypeOf<UnsignedTx>()

    const txWithValue: UnsignedTx = { to: '0x123', value: '1000' }
    expectTypeOf(txWithValue).toMatchTypeOf<UnsignedTx>()

    // memo is supported
    const txWithMemo: UnsignedTx = { to: '0x123', memo: 'test' }
    expectTypeOf(txWithMemo).toMatchTypeOf<UnsignedTx>()

    // fee supports gasLimit and gasPrice
    const txWithFee: UnsignedTx = {
      to: '0x123',
      fee: { gasLimit: '21000', gasPrice: '20000000000' },
    }
    expectTypeOf(txWithFee).toMatchTypeOf<UnsignedTx>()
  })

  it('LegacyUnsignedTx should require from and value', () => {
    expectTypeOf<LegacyUnsignedTx>().toHaveProperty('from')
    expectTypeOf<LegacyUnsignedTx>().toHaveProperty('to')
    expectTypeOf<LegacyUnsignedTx>().toHaveProperty('value')

    expectTypeOf<LegacyUnsignedTx['from']>().toBeString()
    expectTypeOf<LegacyUnsignedTx['to']>().toBeString()
    expectTypeOf<LegacyUnsignedTx['value']>().toBeString()
  })

  it('SendParams should have correct shape', () => {
    expectTypeOf<SendParams>().toHaveProperty('to')
    expectTypeOf<SendParams>().toHaveProperty('amount')

    expectTypeOf<SendParams['to']>().toBeString()
    expectTypeOf<SendParams['amount']>().toBeString()

    // optional fields
    const params: SendParams = { to: '0x123', amount: '1000' }
    expectTypeOf(params).toMatchTypeOf<SendParams>()

    const paramsWithAsset: SendParams = { to: '0x123', amount: '1000', asset: 'USDT', memo: 'payment' }
    expectTypeOf(paramsWithAsset).toMatchTypeOf<SendParams>()
  })

  it('Unsubscribe should be a function returning void', () => {
    expectTypeOf<Unsubscribe>().toEqualTypeOf<() => void>()
  })
})

describe('SignTransactionParams', () => {
  it('should have correct shape', () => {
    expectTypeOf<SignTransactionParams>().toHaveProperty('privateKey')
    expectTypeOf<SignTransactionParams>().toHaveProperty('tx')

    expectTypeOf<SignTransactionParams['privateKey']>().toBeString()

    const params: SignTransactionParams = {
      privateKey: '0xabc',
      tx: { to: '0x123', value: '1000' },
    }
    expectTypeOf(params).toMatchTypeOf<SignTransactionParams>()
  })

  it('should support encoding option', () => {
    const params: SignTransactionParams = {
      privateKey: '0xabc',
      tx: { to: '0x123' },
      options: { encoding: 'broadcast' },
    }
    expectTypeOf(params).toMatchTypeOf<SignTransactionParams>()

    const sigOnly: SignTransactionParams = {
      privateKey: '0xabc',
      tx: { to: '0x123' },
      options: { encoding: 'signature-only' },
    }
    expectTypeOf(sigOnly).toMatchTypeOf<SignTransactionParams>()
  })
})

describe('SignMessageParams', () => {
  it('should have correct shape', () => {
    expectTypeOf<SignMessageParams>().toHaveProperty('message')
    expectTypeOf<SignMessageParams>().toHaveProperty('privateKey')

    expectTypeOf<SignMessageParams['privateKey']>().toBeString()
  })

  it('should accept string or Uint8Array message', () => {
    const strParams: SignMessageParams = { message: 'hello', privateKey: '0xabc' }
    expectTypeOf(strParams).toMatchTypeOf<SignMessageParams>()

    const bytesParams: SignMessageParams = { message: new Uint8Array([1, 2, 3]), privateKey: '0xabc' }
    expectTypeOf(bytesParams).toMatchTypeOf<SignMessageParams>()
  })
})

describe('ChainSigner interface', () => {
  it('should have all required methods', () => {
    expectTypeOf<ChainSigner>().toHaveProperty('generateMnemonic')
    expectTypeOf<ChainSigner>().toHaveProperty('validateMnemonic')
    expectTypeOf<ChainSigner>().toHaveProperty('derivePrivateKey')
    expectTypeOf<ChainSigner>().toHaveProperty('getAddress')
    expectTypeOf<ChainSigner>().toHaveProperty('signTransaction')
    expectTypeOf<ChainSigner>().toHaveProperty('signMessage')
  })

  it('generateMnemonic should return string', () => {
    expectTypeOf<ChainSigner['generateMnemonic']>().returns.toBeString()
  })

  it('validateMnemonic should return boolean', () => {
    expectTypeOf<ChainSigner['validateMnemonic']>().returns.toBeBoolean()
  })

  it('getAddress should return string', () => {
    expectTypeOf<ChainSigner['getAddress']>().returns.toBeString()
  })

  it('signTransaction should accept SignTransactionParams and return Promise<string>', () => {
    expectTypeOf<ChainSigner['signTransaction']>().returns.toEqualTypeOf<Promise<string>>()
  })
})

describe('LegacyChainSigner interface', () => {
  it('should have all required methods with positional args', () => {
    expectTypeOf<LegacyChainSigner>().toHaveProperty('generateMnemonic')
    expectTypeOf<LegacyChainSigner>().toHaveProperty('validateMnemonic')
    expectTypeOf<LegacyChainSigner>().toHaveProperty('derivePrivateKey')
    expectTypeOf<LegacyChainSigner>().toHaveProperty('getAddress')
    expectTypeOf<LegacyChainSigner>().toHaveProperty('signTransaction')
    expectTypeOf<LegacyChainSigner>().toHaveProperty('signMessage')
  })

  it('derivePrivateKey should return Promise<HexString>', () => {
    expectTypeOf<LegacyChainSigner['derivePrivateKey']>().returns.toEqualTypeOf<Promise<string>>()
  })

  it('signTransaction should return Promise<HexString>', () => {
    expectTypeOf<LegacyChainSigner['signTransaction']>().returns.toEqualTypeOf<Promise<string>>()
  })

  it('signMessage should return Promise<HexString>', () => {
    expectTypeOf<LegacyChainSigner['signMessage']>().returns.toEqualTypeOf<Promise<string>>()
  })
})

describe('ChainProvider interface', () => {
  it('should have all required methods', () => {
    expectTypeOf<ChainProvider>().toHaveProperty('getBalance')
    expectTypeOf<ChainProvider>().toHaveProperty('getTransaction')
    expectTypeOf<ChainProvider>().toHaveProperty('getBlock')
    expectTypeOf<ChainProvider>().toHaveProperty('estimateFee')
    expectTypeOf<ChainProvider>().toHaveProperty('broadcastTransaction')
    expectTypeOf<ChainProvider>().toHaveProperty('getChainInfo')
  })

  it('getBalance should return Promise<Balance>', () => {
    expectTypeOf<ChainProvider['getBalance']>().returns.toEqualTypeOf<Promise<Balance>>()
  })

  it('getTransaction should return Promise<TransactionInfo | null>', () => {
    expectTypeOf<ChainProvider['getTransaction']>().returns.toEqualTypeOf<Promise<TransactionInfo | null>>()
  })

  it('estimateFee should return Promise<FeeEstimate>', () => {
    expectTypeOf<ChainProvider['estimateFee']>().returns.toEqualTypeOf<Promise<FeeEstimate>>()
  })

  it('getNativeBalances should be an optional method returning Promise<Balance[]>', () => {
    // getNativeBalances is optional (marked with ?)
    type HasGetNativeBalances = Required<ChainProvider>
    expectTypeOf<HasGetNativeBalances['getNativeBalances']>().returns.toEqualTypeOf<Promise<Balance[]>>()
  })
})

describe('ProviderConfig', () => {
  it('EndpointStrategy should be a union of strategies', () => {
    const strategy1: EndpointStrategy = 'failover'
    const strategy2: EndpointStrategy = 'round-robin'
    const strategy3: EndpointStrategy = 'fastest'
    expectTypeOf(strategy1).toMatchTypeOf<EndpointStrategy>()
    expectTypeOf(strategy2).toMatchTypeOf<EndpointStrategy>()
    expectTypeOf(strategy3).toMatchTypeOf<EndpointStrategy>()
  })

  it('EndpointConfig should have url and optional headers', () => {
    expectTypeOf<EndpointConfig>().toHaveProperty('url')
    expectTypeOf<EndpointConfig['url']>().toBeString()

    const config: EndpointConfig = { url: 'https://rpc.example.com' }
    expectTypeOf(config).toMatchTypeOf<EndpointConfig>()

    const configWithHeaders: EndpointConfig = {
      url: 'https://rpc.example.com',
      headers: { Authorization: 'Bearer token' },
    }
    expectTypeOf(configWithHeaders).toMatchTypeOf<EndpointConfig>()
  })

  it('EndpointInput should accept various formats', () => {
    const str: EndpointInput = 'https://rpc.example.com'
    expectTypeOf(str).toMatchTypeOf<EndpointInput>()

    const config: EndpointInput = { url: 'https://rpc.example.com' }
    expectTypeOf(config).toMatchTypeOf<EndpointInput>()

    const strArr: EndpointInput = ['https://rpc1.example.com', 'https://rpc2.example.com']
    expectTypeOf(strArr).toMatchTypeOf<EndpointInput>()

    const configArr: EndpointInput = [{ url: 'https://rpc1.example.com' }, { url: 'https://rpc2.example.com' }]
    expectTypeOf(configArr).toMatchTypeOf<EndpointInput>()
  })

  it('ProviderConfig should have correct shape', () => {
    expectTypeOf<ProviderConfig>().toHaveProperty('endpoints')

    // flat endpoint
    const flatConfig: ProviderConfig = {
      endpoints: 'https://rpc.example.com',
    }
    expectTypeOf(flatConfig).toMatchTypeOf<ProviderConfig>()

    // categorized endpoints
    const catConfig: ProviderConfig = {
      endpoints: {
        rpc: 'https://rpc.example.com',
        rest: 'https://rest.example.com',
      },
      strategy: 'failover',
      timeoutMs: 5000,
      retries: 3,
    }
    expectTypeOf(catConfig).toMatchTypeOf<ProviderConfig>()

    // with lcd, indexer, mirror
    const fullConfig: ProviderConfig = {
      endpoints: {
        rpc: ['https://rpc1.example.com', 'https://rpc2.example.com'],
        lcd: { url: 'https://lcd.example.com', headers: { 'X-Api-Key': 'key' } },
        indexer: 'https://indexer.example.com',
        mirror: 'https://mirror.example.com',
      },
      strategy: 'round-robin',
    }
    expectTypeOf(fullConfig).toMatchTypeOf<ProviderConfig>()
  })
})

describe('FeeEstimate', () => {
  it('should have slow, average, fast, unit', () => {
    expectTypeOf<FeeEstimate>().toHaveProperty('slow')
    expectTypeOf<FeeEstimate>().toHaveProperty('average')
    expectTypeOf<FeeEstimate>().toHaveProperty('fast')
    expectTypeOf<FeeEstimate>().toHaveProperty('unit')

    expectTypeOf<FeeEstimate['slow']>().toBeString()
    expectTypeOf<FeeEstimate['average']>().toBeString()
    expectTypeOf<FeeEstimate['fast']>().toBeString()
    expectTypeOf<FeeEstimate['unit']>().toBeString()
  })
})

describe('Capability interfaces', () => {
  it('ContractCapable should have callContract and estimateGas', () => {
    expectTypeOf<ContractCapable>().toHaveProperty('callContract')
    expectTypeOf<ContractCapable>().toHaveProperty('estimateGas')
  })

  it('TokenCapable should have getTokenBalance and getTokenMetadata', () => {
    expectTypeOf<TokenCapable>().toHaveProperty('getTokenBalance')
    expectTypeOf<TokenCapable>().toHaveProperty('getTokenMetadata')
  })

  it('SubscriptionCapable should have subscribeBlocks and subscribeTransactions', () => {
    expectTypeOf<SubscriptionCapable>().toHaveProperty('subscribeBlocks')
    expectTypeOf<SubscriptionCapable>().toHaveProperty('subscribeTransactions')
  })

  it('UtxoCapable should have getUtxos and selectUtxos', () => {
    expectTypeOf<UtxoCapable>().toHaveProperty('getUtxos')
    expectTypeOf<UtxoCapable>().toHaveProperty('selectUtxos')
  })
})

describe('ChainKitError', () => {
  it('should be an instance of Error', () => {
    const error = new ChainKitError(ErrorCode.UNKNOWN, 'test')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ChainKitError)
  })

  it('should have correct properties', () => {
    const error = new ChainKitError(ErrorCode.NETWORK_ERROR, 'connection failed', {
      url: 'http://example.com',
    })

    expect(error.name).toBe('ChainKitError')
    expect(error.code).toBe(ErrorCode.NETWORK_ERROR)
    expect(error.message).toBe('connection failed')
    expect(error.context).toEqual({ url: 'http://example.com' })
  })

  it('should work without context', () => {
    const error = new ChainKitError(ErrorCode.TIMEOUT, 'request timed out')
    expect(error.code).toBe(ErrorCode.TIMEOUT)
    expect(error.context).toBeUndefined()
  })

  it('should have all error codes', () => {
    expect(ErrorCode.UNKNOWN).toBe('UNKNOWN')
    expect(ErrorCode.NETWORK_ERROR).toBe('NETWORK_ERROR')
    expect(ErrorCode.TIMEOUT).toBe('TIMEOUT')
    expect(ErrorCode.INVALID_PARAMS).toBe('INVALID_PARAMS')
    expect(ErrorCode.INVALID_ADDRESS).toBe('INVALID_ADDRESS')
    expect(ErrorCode.INVALID_MNEMONIC).toBe('INVALID_MNEMONIC')
    expect(ErrorCode.INVALID_PATH).toBe('INVALID_PATH')
    expect(ErrorCode.INVALID_PRIVATE_KEY).toBe('INVALID_PRIVATE_KEY')
    expect(ErrorCode.TRANSACTION_FAILED).toBe('TRANSACTION_FAILED')
    expect(ErrorCode.INSUFFICIENT_BALANCE).toBe('INSUFFICIENT_BALANCE')
    expect(ErrorCode.RPC_ALL_FAILED).toBe('RPC_ALL_FAILED')
    expect(ErrorCode.RPC_ERROR).toBe('RPC_ERROR')
    expect(ErrorCode.UNSUPPORTED_CHAIN).toBe('UNSUPPORTED_CHAIN')
    expect(ErrorCode.UNSUPPORTED_FEATURE).toBe('UNSUPPORTED_FEATURE')
    expect(ErrorCode.SIGNING_FAILED).toBe('SIGNING_FAILED')
  })
})
