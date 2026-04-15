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
  Unsubscribe,
  ChainSigner,
  ChainProvider,
  FeeEstimate,
  ContractCapable,
  TokenCapable,
  SubscriptionCapable,
  UtxoCapable,
} from './types/index.js'

// Error classes & enums
export { ChainKitError, ErrorCode } from './types/index.js'

// RPC Manager
export { RpcManager } from './rpc/index.js'
export type { RpcManagerConfig, RpcStrategy, JsonRpcRequest, JsonRpcResponse } from './rpc/index.js'
