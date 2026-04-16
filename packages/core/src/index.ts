// Types & Interfaces
export type {
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
  EvmSignerCapable,
  TypedDataDomain,
  TypedDataField,
  WaitForTransactionOptions,
} from './types/index.js'

// Error classes & enums
export { ChainKitError, ErrorCode } from './types/index.js'

// RPC Manager
export { RpcManager } from './rpc/index.js'
export type { RpcManagerConfig, RpcStrategy, JsonRpcRequest, JsonRpcResponse } from './rpc/index.js'

// Crypto Utilities
export {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  mnemonicToSeedSync,
  derivePath,
  derivePublicKey,
} from './crypto/index.js'

// Transaction Utilities
export { waitForTransaction } from './utils/index.js'

// ABI Encoder/Decoder
export {
  encodeFunctionCall,
  encodeFunctionSelector,
  encodeAddress,
  encodeUint256,
  encodeInt256,
  encodeBytes32,
  encodeString,
  encodeBool,
  encodeBytes,
  decodeFunctionResult,
  decodeAddress,
  decodeUint256,
  decodeInt256,
  decodeString,
  decodeBool,
  decodeBytes32,
  ERC20,
} from './abi/index.js'
