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
  Unsubscribe,
  ChainSigner,
  ChainProvider,
  FeeEstimate,
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

  it('UnsignedTx should have correct shape', () => {
    expectTypeOf<UnsignedTx>().toHaveProperty('from')
    expectTypeOf<UnsignedTx>().toHaveProperty('to')
    expectTypeOf<UnsignedTx>().toHaveProperty('value')
  })

  it('Unsubscribe should be a function returning void', () => {
    expectTypeOf<Unsubscribe>().toEqualTypeOf<() => void>()
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

  it('derivePrivateKey should return Promise<HexString>', () => {
    expectTypeOf<ChainSigner['derivePrivateKey']>().returns.toEqualTypeOf<Promise<string>>()
  })

  it('getAddress should return Address', () => {
    expectTypeOf<ChainSigner['getAddress']>().returns.toBeString()
  })

  it('signTransaction should return Promise<HexString>', () => {
    expectTypeOf<ChainSigner['signTransaction']>().returns.toEqualTypeOf<Promise<string>>()
  })

  it('signMessage should return Promise<HexString>', () => {
    expectTypeOf<ChainSigner['signMessage']>().returns.toEqualTypeOf<Promise<string>>()
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
