import {
  RpcManager,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type {
  ChainProvider,
  FeeEstimate,
  ContractCapable,
  TokenCapable,
  SubscriptionCapable,
  Address,
  TxHash,
  Balance,
  TransactionInfo,
  BlockInfo,
  ChainInfo,
  HexString,
  TokenMetadata,
  Unsubscribe,
  RpcManagerConfig,
} from '@chainkit/core'
import { blake2b } from '@noble/hashes/blake2b'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import type { PolkadotNetwork } from './signer.js'
import { decodeSS58 } from './signer.js'

/**
 * Network-specific metadata for Polkadot ecosystem chains.
 */
interface PolkadotNetworkMeta {
  symbol: string
  decimals: number
}

const NETWORK_META: Record<PolkadotNetwork, PolkadotNetworkMeta> = {
  polkadot: { symbol: 'DOT', decimals: 10 },
  kusama: { symbol: 'KSM', decimals: 12 },
  substrate: { symbol: 'DOT', decimals: 10 },
}

/**
 * Compute the blake2b-128 hash of a value and concatenate it with the value.
 * This is the "blake2_128_concat" hasher used in Substrate storage.
 */
function blake2128Concat(data: Uint8Array): Uint8Array {
  const hash = blake2b(data, { dkLen: 16 }) // 128 bits = 16 bytes
  const result = new Uint8Array(hash.length + data.length)
  result.set(hash, 0)
  result.set(data, hash.length)
  return result
}

/**
 * Compute the twox128 hash of a string (used for module/method name hashing in Substrate storage).
 * XXHash-128 implemented as two 64-bit xxhash rounds with seeds 0 and 1.
 *
 * For simplicity, we use the well-known pre-computed storage prefix for System.Account.
 */
function twox128(input: string): Uint8Array {
  // xxhash64 implementation for Substrate storage key generation
  const data = new TextEncoder().encode(input)
  const h0 = xxhash64(data, 0n)
  const h1 = xxhash64(data, 1n)

  const result = new Uint8Array(16)
  // Little-endian encoding of h0 and h1
  for (let i = 0; i < 8; i++) {
    result[i] = Number((h0 >> BigInt(i * 8)) & 0xffn)
    result[i + 8] = Number((h1 >> BigInt(i * 8)) & 0xffn)
  }
  return result
}

/**
 * xxHash-64 implementation used by Substrate's twox hashing.
 */
function xxhash64(data: Uint8Array, seed: bigint): bigint {
  const PRIME64_1 = 0x9e3779b185ebca87n
  const PRIME64_2 = 0x14def9dea2f79cd6n
  const PRIME64_3 = 0x165667b19e3779f9n
  const PRIME64_4 = 0x85ebca77c2b2ae63n
  const PRIME64_5 = 0x27d4eb2f165667c5n
  const MASK64 = 0xffffffffffffffffn

  const len = BigInt(data.length)
  let h: bigint
  let pos = 0

  if (data.length >= 32) {
    let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK64
    let v2 = (seed + PRIME64_2) & MASK64
    let v3 = seed
    let v4 = (seed - PRIME64_1) & MASK64

    while (pos + 32 <= data.length) {
      v1 = xxhash64Round(v1, readU64LE(data, pos))
      pos += 8
      v2 = xxhash64Round(v2, readU64LE(data, pos))
      pos += 8
      v3 = xxhash64Round(v3, readU64LE(data, pos))
      pos += 8
      v4 = xxhash64Round(v4, readU64LE(data, pos))
      pos += 8
    }

    h = (rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n)) & MASK64
    h = xxhash64MergeRound(h, v1)
    h = xxhash64MergeRound(h, v2)
    h = xxhash64MergeRound(h, v3)
    h = xxhash64MergeRound(h, v4)
  } else {
    h = (seed + PRIME64_5) & MASK64
  }

  h = (h + len) & MASK64

  while (pos + 8 <= data.length) {
    const k1 = xxhash64Round(0n, readU64LE(data, pos))
    pos += 8
    h = (h ^ k1) & MASK64
    h = (rotl64(h, 27n) * PRIME64_1 + PRIME64_4) & MASK64
  }

  while (pos + 4 <= data.length) {
    const val = BigInt(data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24)) & 0xffffffffn
    h = (h ^ (val * PRIME64_1)) & MASK64
    h = (rotl64(h, 23n) * PRIME64_2 + PRIME64_3) & MASK64
    pos += 4
  }

  while (pos < data.length) {
    h = (h ^ (BigInt(data[pos]) * PRIME64_5)) & MASK64
    h = (rotl64(h, 11n) * PRIME64_1) & MASK64
    pos++
  }

  h = xxhash64Avalanche(h)
  return h
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let val = 0n
  for (let i = 0; i < 8; i++) {
    val |= BigInt(data[offset + i]) << BigInt(i * 8)
  }
  return val
}

function rotl64(val: bigint, shift: bigint): bigint {
  const MASK64 = 0xffffffffffffffffn
  return ((val << shift) | (val >> (64n - shift))) & MASK64
}

function xxhash64Round(acc: bigint, input: bigint): bigint {
  const PRIME64_1 = 0x9e3779b185ebca87n
  const PRIME64_2 = 0x14def9dea2f79cd6n
  const MASK64 = 0xffffffffffffffffn
  acc = (acc + input * PRIME64_2) & MASK64
  acc = rotl64(acc, 31n)
  acc = (acc * PRIME64_1) & MASK64
  return acc
}

function xxhash64MergeRound(acc: bigint, val: bigint): bigint {
  const PRIME64_1 = 0x9e3779b185ebca87n
  const PRIME64_4 = 0x85ebca77c2b2ae63n
  const MASK64 = 0xffffffffffffffffn
  val = xxhash64Round(0n, val)
  acc = (acc ^ val) & MASK64
  acc = (acc * PRIME64_1 + PRIME64_4) & MASK64
  return acc
}

function xxhash64Avalanche(h: bigint): bigint {
  const MASK64 = 0xffffffffffffffffn
  h = ((h ^ (h >> 33n)) * 0x14def9dea2f79cd6n) & MASK64
  h = ((h ^ (h >> 29n)) * 0x165667b19e3779f9n) & MASK64
  h = (h ^ (h >> 32n)) & MASK64
  return h
}

/**
 * Build the Substrate storage key for System.Account(accountId).
 * Storage key = twox128("System") + twox128("Account") + blake2_128_concat(accountId)
 */
function systemAccountStorageKey(accountPublicKey: Uint8Array): string {
  const moduleHash = twox128('System')
  const methodHash = twox128('Account')
  const accountHash = blake2128Concat(accountPublicKey)

  const key = new Uint8Array(moduleHash.length + methodHash.length + accountHash.length)
  key.set(moduleHash, 0)
  key.set(methodHash, moduleHash.length)
  key.set(accountHash, moduleHash.length + methodHash.length)

  return '0x' + bytesToHex(key)
}

/**
 * Decode SCALE-encoded AccountInfo to extract free balance.
 * AccountInfo layout (simplified):
 * - nonce: u32 (4 bytes)
 * - consumers: u32 (4 bytes)
 * - providers: u32 (4 bytes)
 * - sufficients: u32 (4 bytes)
 * - data.free: u128 (16 bytes, little-endian)
 * - data.reserved: u128 (16 bytes)
 * - data.frozen: u128 (16 bytes)
 */
function decodeAccountFreeBalance(hex: string): string {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex

  if (data.length < 64) {
    // Insufficient data, return 0
    return '0'
  }

  // Skip nonce(4) + consumers(4) + providers(4) + sufficients(4) = 16 bytes = 32 hex chars
  const freeBalanceHex = data.slice(32, 64) // 16 bytes = 32 hex chars for u128

  // Convert little-endian hex to BigInt
  let result = 0n
  for (let i = 0; i < 32; i += 2) {
    const byte = BigInt(parseInt(freeBalanceHex.slice(i, i + 2), 16))
    result |= byte << BigInt((i / 2) * 8)
  }

  return result.toString()
}

/**
 * Polkadot provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses Polkadot JSON-RPC via an internal RpcManager.
 */
export class PolkadotProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager
  private readonly network: PolkadotNetwork
  private readonly meta: PolkadotNetworkMeta

  constructor(config: RpcManagerConfig, network: PolkadotNetwork = 'polkadot') {
    this.rpc = new RpcManager(config)
    this.network = network
    this.meta = NETWORK_META[network]
  }

  // ------- ChainProvider -------

  /**
   * Get the native token balance of an address.
   * Queries the System.Account storage to retrieve the free balance.
   */
  async getBalance(address: Address): Promise<Balance> {
    // Decode the SS58 address to get the raw public key
    const { publicKey } = decodeSS58(address)

    // Build the storage key for System.Account
    const storageKey = systemAccountStorageKey(publicKey)

    // Query the storage
    const result = await this.rpc.request<string | null>('state_getStorage', [storageKey])

    let amount = '0'
    if (result) {
      amount = decodeAccountFreeBalance(result)
    }

    return {
      address,
      amount,
      symbol: this.meta.symbol,
      decimals: this.meta.decimals,
    }
  }

  /**
   * Get transaction (extrinsic) details by hash.
   * Uses chain_getBlock and searches for the extrinsic.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    // Polkadot doesn't have a direct getTransaction RPC.
    // We need to search through blocks. For simplicity, try to find the extrinsic
    // by querying the system events for the given extrinsic hash.
    try {
      // Try to get block containing this extrinsic
      const header = await this.rpc.request<Record<string, unknown>>('chain_getHeader', [])
      const blockHash = await this.rpc.request<string>('chain_getBlockHash', [])

      const block = await this.rpc.request<Record<string, unknown>>('chain_getBlock', [blockHash])

      if (!block) return null

      const blockData = block.block as Record<string, unknown>
      const extrinsics = blockData.extrinsics as string[] | undefined
      const headerData = blockData.header as Record<string, unknown>
      const blockNumber = parseInt(headerData.number as string, 16)

      // Search for the extrinsic hash in the block
      if (extrinsics) {
        for (const ext of extrinsics) {
          if (ext === hash || hash.includes(ext)) {
            return {
              hash,
              from: '',
              to: null,
              value: '0',
              fee: '0',
              blockNumber,
              blockHash: blockHash,
              status: 'confirmed',
              timestamp: null,
              nonce: 0,
            }
          }
        }
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Get block details by number or hash.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    let blockHash: string

    if (typeof hashOrNumber === 'number') {
      // Get block hash from block number
      blockHash = await this.rpc.request<string>('chain_getBlockHash', [hashOrNumber])
    } else if (hashOrNumber.startsWith('0x')) {
      blockHash = hashOrNumber
    } else {
      // Treat as decimal block number
      const blockNum = parseInt(hashOrNumber, 10)
      if (isNaN(blockNum)) {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          `Invalid block identifier: ${hashOrNumber}`,
        )
      }
      blockHash = await this.rpc.request<string>('chain_getBlockHash', [blockNum])
    }

    if (!blockHash) return null

    try {
      const result = await this.rpc.request<Record<string, unknown>>('chain_getBlock', [blockHash])
      if (!result) return null

      const blockData = result.block as Record<string, unknown>
      const header = blockData.header as Record<string, unknown>
      const extrinsics = (blockData.extrinsics as string[]) ?? []

      const number = parseInt(header.number as string, 16)
      const parentHash = header.parentHash as string

      return {
        number,
        hash: blockHash,
        parentHash,
        timestamp: 0,
        transactions: extrinsics,
      }
    } catch {
      return null
    }
  }

  /**
   * Estimate transaction fees using payment_queryInfo RPC.
   * Since this requires a specific extrinsic, we return default estimates.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Polkadot fees are weight-based and depend on the specific extrinsic.
    // Provide sensible defaults for a basic balance transfer.
    // Typical DOT transfer fee is ~0.015 DOT = 150,000,000 planck
    const baseFee = 150000000 // ~0.015 DOT in planck

    return {
      slow: baseFee.toString(),
      average: (baseFee * 2).toString(),
      fast: (baseFee * 3).toString(),
      unit: 'planck',
    }
  }

  /**
   * Broadcast a signed extrinsic to the Polkadot network.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    return this.rpc.request<string>('author_submitExtrinsic', [signedTx])
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [chain, header] = await Promise.all([
      this.rpc.request<string>('system_chain', []),
      this.rpc.request<Record<string, string>>('chain_getHeader', []),
    ])

    const blockHeight = parseInt(header.number, 16)

    // Determine if testnet based on chain name
    const chainLower = chain.toLowerCase()
    const testnet = chainLower.includes('testnet') ||
      chainLower.includes('westend') ||
      chainLower.includes('rococo') ||
      chainLower.includes('development')

    return {
      chainId: chain,
      name: chain,
      symbol: this.meta.symbol,
      decimals: this.meta.decimals,
      testnet,
      blockHeight,
    }
  }

  // ------- ContractCapable (ink! smart contracts) -------

  /**
   * Call a read-only ink! contract method.
   * Uses state_call with "ContractsApi_call" runtime API.
   * @param contractAddress - The contract address (SS58 encoded)
   * @param method - Hex-encoded call data for the contract
   * @param params - Optional parameters
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // For ink! contracts, we use the contracts_call RPC
    const { publicKey } = decodeSS58(contractAddress)

    const callData = method.startsWith('0x') ? method : `0x${method}`

    const result = await this.rpc.request<Record<string, unknown>>('contracts_call', [
      {
        origin: contractAddress,
        dest: contractAddress,
        value: 0,
        gasLimit: null,
        storageDepositLimit: null,
        inputData: callData,
      },
    ])

    return result
  }

  /**
   * Estimate gas (weight) for an ink! contract call.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    const callData = method.startsWith('0x') ? method : `0x${method}`

    try {
      const result = await this.rpc.request<Record<string, unknown>>('contracts_call', [
        {
          origin: contractAddress,
          dest: contractAddress,
          value: 0,
          gasLimit: null,
          storageDepositLimit: null,
          inputData: callData,
        },
      ])

      const gasConsumed = result.gasConsumed as Record<string, unknown> | undefined
      if (gasConsumed) {
        const refTime = gasConsumed.refTime as string | number | undefined
        return refTime?.toString() ?? '0'
      }
    } catch {
      // Fall through to default
    }

    return '0'
  }

  // ------- TokenCapable -------

  /**
   * Get token balance for an address.
   * For Substrate assets pallet, query Assets.Account storage.
   * @param address - The holder address (SS58 encoded)
   * @param tokenAddress - The asset ID as a string
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    // For substrate, token address is typically an asset ID
    // Query the Assets pallet storage
    const { publicKey } = decodeSS58(address)

    // Try to use the assets pallet storage key
    // Assets.Account storage key = twox128("Assets") + twox128("Account") + blake2_128_concat(asset_id) + blake2_128_concat(account_id)
    try {
      const moduleHash = twox128('Assets')
      const methodHash = twox128('Account')

      // Encode asset ID as u32 little-endian
      const assetId = parseInt(tokenAddress, 10)
      const assetIdBytes = new Uint8Array(4)
      assetIdBytes[0] = assetId & 0xff
      assetIdBytes[1] = (assetId >> 8) & 0xff
      assetIdBytes[2] = (assetId >> 16) & 0xff
      assetIdBytes[3] = (assetId >> 24) & 0xff

      const assetHash = blake2128Concat(assetIdBytes)
      const accountHash = blake2128Concat(publicKey)

      const key = new Uint8Array(moduleHash.length + methodHash.length + assetHash.length + accountHash.length)
      key.set(moduleHash, 0)
      key.set(methodHash, moduleHash.length)
      key.set(assetHash, moduleHash.length + methodHash.length)
      key.set(accountHash, moduleHash.length + methodHash.length + assetHash.length)

      const storageKey = '0x' + bytesToHex(key)
      const result = await this.rpc.request<string | null>('state_getStorage', [storageKey])

      if (result) {
        // Decode SCALE-encoded AssetBalance
        const data = result.startsWith('0x') ? result.slice(2) : result
        // AssetBalance: balance (u128 LE, 16 bytes) + status fields
        if (data.length >= 32) {
          const balanceHex = data.slice(0, 32)
          let amount = 0n
          for (let i = 0; i < 32; i += 2) {
            const byte = BigInt(parseInt(balanceHex.slice(i, i + 2), 16))
            amount |= byte << BigInt((i / 2) * 8)
          }
          return {
            address,
            amount: amount.toString(),
            symbol: '',
            decimals: 0,
          }
        }
      }
    } catch {
      // Fall through
    }

    return {
      address,
      amount: '0',
      symbol: '',
      decimals: 0,
    }
  }

  /**
   * Get metadata for a token (asset).
   * @param tokenAddress - The asset ID as a string
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    // Query Assets.Metadata storage
    try {
      const moduleHash = twox128('Assets')
      const methodHash = twox128('Metadata')

      const assetId = parseInt(tokenAddress, 10)
      const assetIdBytes = new Uint8Array(4)
      assetIdBytes[0] = assetId & 0xff
      assetIdBytes[1] = (assetId >> 8) & 0xff
      assetIdBytes[2] = (assetId >> 16) & 0xff
      assetIdBytes[3] = (assetId >> 24) & 0xff

      const assetHash = blake2128Concat(assetIdBytes)

      const key = new Uint8Array(moduleHash.length + methodHash.length + assetHash.length)
      key.set(moduleHash, 0)
      key.set(methodHash, moduleHash.length)
      key.set(assetHash, moduleHash.length + methodHash.length)

      const storageKey = '0x' + bytesToHex(key)
      const result = await this.rpc.request<string | null>('state_getStorage', [storageKey])

      if (result) {
        // Basic metadata return
        return {
          address: tokenAddress,
          name: '',
          symbol: '',
          decimals: 0,
        }
      }
    } catch {
      // Fall through
    }

    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      `Asset not found: ${tokenAddress}`,
    )
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Polls every ~6 seconds (Polkadot block time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const header = await this.rpc.request<Record<string, string>>('chain_getHeader', [])
          const blockNumber = parseInt(header.number, 16)

          if (blockNumber > lastBlockNumber) {
            lastBlockNumber = blockNumber
            callback(blockNumber)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 6000))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }

  /**
   * Subscribe to transactions (extrinsics) for an address via polling.
   * Polls new blocks and checks for extrinsics involving the address.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    // Initialize with current block
    try {
      const header = await this.rpc.request<Record<string, string>>('chain_getHeader', [])
      lastBlockNumber = parseInt(header.number, 16)
    } catch {
      // Start from 0
    }

    const poll = async () => {
      while (active) {
        try {
          const header = await this.rpc.request<Record<string, string>>('chain_getHeader', [])
          const currentBlock = parseInt(header.number, 16)

          if (currentBlock > lastBlockNumber) {
            for (
              let blockNum = lastBlockNumber + 1;
              blockNum <= currentBlock && active;
              blockNum++
            ) {
              const blockHash = await this.rpc.request<string>('chain_getBlockHash', [blockNum])
              const block = await this.rpc.request<Record<string, unknown>>('chain_getBlock', [blockHash])

              if (block) {
                const blockData = block.block as Record<string, unknown>
                const extrinsics = (blockData.extrinsics as string[]) ?? []

                for (const ext of extrinsics) {
                  // Basic check: see if the address's public key appears in the extrinsic data
                  try {
                    const { publicKey } = decodeSS58(address)
                    const pubkeyHex = bytesToHex(publicKey)
                    if (ext.includes(pubkeyHex)) {
                      callback({
                        hash: ext,
                        from: address,
                        to: null,
                        value: '0',
                        fee: '0',
                        blockNumber: blockNum,
                        blockHash,
                        status: 'confirmed',
                        timestamp: null,
                        nonce: 0,
                      })
                    }
                  } catch {
                    // Skip invalid addresses
                  }
                }
              }
            }
            lastBlockNumber = currentBlock
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 6000))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }
}
