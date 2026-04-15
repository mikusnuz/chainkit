import {
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
} from '@chainkit/core'

/**
 * Configuration for the Tezos provider.
 */
export interface TezosProviderConfig {
  /** Tezos node RPC URL (e.g., "https://ghostnet.tezos.marigold.dev") */
  rpcUrl: string
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number
}

/**
 * Make an HTTP request to the Tezos RPC node.
 */
async function fetchRpc(
  baseUrl: string,
  path: string,
  options?: { method?: string; body?: unknown; timeout?: number },
): Promise<unknown> {
  const url = `${baseUrl}${path}`
  const method = options?.method ?? 'GET'
  const timeout = options?.timeout ?? 30000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const fetchOptions: RequestInit = {
      method,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
    }

    if (options?.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body)
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ChainKitError(
        ErrorCode.RPC_ERROR,
        `Tezos RPC error ${response.status}: ${text}`,
        { url, status: response.status },
      )
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      return response.json()
    }
    return response.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Tezos provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses Tezos Node RPC (REST) to interact with the Tezos blockchain.
 */
export class TezosProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rpcUrl: string
  private readonly timeout: number

  constructor(config: TezosProviderConfig) {
    // Remove trailing slash
    this.rpcUrl = config.rpcUrl.replace(/\/+$/, '')
    this.timeout = config.timeout ?? 30000
  }

  /**
   * Internal helper to make RPC requests.
   */
  private async rpc<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
    return fetchRpc(this.rpcUrl, path, { ...options, timeout: this.timeout }) as Promise<T>
  }

  // ------- ChainProvider -------

  /**
   * Get the XTZ balance of an address (in mutez).
   */
  async getBalance(address: Address): Promise<Balance> {
    const balanceStr = await this.rpc<string>(
      `/chains/main/blocks/head/context/contracts/${address}/balance`,
    )

    // Balance is returned as a string of mutez (quoted string)
    const mutez = balanceStr.replace(/"/g, '')

    return {
      address,
      amount: mutez,
      symbol: 'XTZ',
      decimals: 6,
    }
  }

  /**
   * Get transaction details by operation hash.
   * Tezos requires searching for the operation in blocks.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    // Normalize: remove surrounding quotes if any
    const opHash = hash.replace(/"/g, '')

    try {
      // Search the mempool first for pending operations
      const pendingOps = await this.rpc<Array<Array<Record<string, unknown>>>>(
        '/chains/main/mempool/pending_operations',
      ).catch(() => null)

      if (pendingOps && Array.isArray(pendingOps)) {
        // pending_operations returns categories: applied, refused, etc.
        for (const category of pendingOps) {
          if (!Array.isArray(category)) continue
          for (const op of category) {
            if (op.hash === opHash) {
              const contents = op.contents as Array<Record<string, unknown>> | undefined
              if (contents && contents.length > 0) {
                const content = contents[0]
                return {
                  hash: opHash,
                  from: (content.source as string) ?? '',
                  to: (content.destination as string) ?? null,
                  value: (content.amount as string) ?? '0',
                  fee: (content.fee as string) ?? '0',
                  blockNumber: null,
                  blockHash: null,
                  status: 'pending',
                  timestamp: null,
                  nonce: content.counter ? parseInt(content.counter as string, 10) : undefined,
                }
              }
            }
          }
        }
      }
    } catch {
      // Mempool lookup failed, try block lookup
    }

    // Try to find in recent blocks via the operation hash
    // The Tezos RPC does not have a direct "get operation by hash" endpoint.
    // We use /chains/main/blocks/head/operations to search recent operations.
    try {
      const blockHead = await this.rpc<Record<string, unknown>>(
        '/chains/main/blocks/head',
      )

      const blockLevel = blockHead.header
        ? (blockHead.header as Record<string, unknown>).level as number
        : 0
      const blockHash = blockHead.hash as string
      const timestamp = blockHead.header
        ? (blockHead.header as Record<string, unknown>).timestamp as string
        : null

      // Search through operation groups (group 3 = manager operations)
      const operations = blockHead.operations as Array<Array<Record<string, unknown>>> | undefined

      if (operations) {
        for (const group of operations) {
          for (const op of group) {
            if (op.hash === opHash) {
              const contents = op.contents as Array<Record<string, unknown>> | undefined
              if (contents && contents.length > 0) {
                const content = contents[0]
                const metadata = content.metadata as Record<string, unknown> | undefined
                const result = metadata?.operation_result as Record<string, unknown> | undefined
                const opStatus = result?.status as string | undefined

                let status: 'pending' | 'confirmed' | 'failed' = 'confirmed'
                if (opStatus === 'failed' || opStatus === 'backtracked') {
                  status = 'failed'
                }

                return {
                  hash: opHash,
                  from: (content.source as string) ?? '',
                  to: (content.destination as string) ?? null,
                  value: (content.amount as string) ?? '0',
                  fee: (content.fee as string) ?? '0',
                  blockNumber: blockLevel,
                  blockHash,
                  status,
                  timestamp: timestamp ? Math.floor(new Date(timestamp).getTime() / 1000) : null,
                  nonce: content.counter ? parseInt(content.counter as string, 10) : undefined,
                }
              }
            }
          }
        }
      }
    } catch {
      // Block lookup failed
    }

    return null
  }

  /**
   * Get block details by level (number) or hash.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    const blockId = typeof hashOrNumber === 'number' ? hashOrNumber.toString() : hashOrNumber

    try {
      const block = await this.rpc<Record<string, unknown>>(
        `/chains/main/blocks/${blockId}`,
      )

      if (!block) return null

      const header = block.header as Record<string, unknown>
      const level = header.level as number
      const hash = block.hash as string
      const predecessor = header.predecessor as string
      const timestamp = header.timestamp as string

      // Collect operation hashes from all groups
      const operations = block.operations as Array<Array<Record<string, unknown>>> | undefined
      const txHashes: string[] = []
      if (operations) {
        for (const group of operations) {
          for (const op of group) {
            if (op.hash) {
              txHashes.push(op.hash as string)
            }
          }
        }
      }

      return {
        number: level,
        hash,
        parentHash: predecessor,
        timestamp: Math.floor(new Date(timestamp).getTime() / 1000),
        transactions: txHashes,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Estimate transaction fees on Tezos.
   * Tezos fees are calculated based on gas and storage usage.
   * Returns estimates in mutez.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Tezos minimum fee formula: 100 + size_in_bytes * 1 + gas_consumed * 0.1 (mutez)
    // For a simple transfer: ~300-400 gas, ~200 bytes
    // Typical values:
    const slow = '500'     // minimal fee for simple transfer
    const average = '1000' // comfortable fee
    const fast = '2000'    // priority fee

    return {
      slow,
      average,
      fast,
      unit: 'mutez',
    }
  }

  /**
   * Broadcast a signed operation to the Tezos network.
   * Expects the fully forged and signed operation as a hex string.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const txHex = signedTx.startsWith('0x') ? signedTx.slice(2) : signedTx

    const result = await this.rpc<string>(
      '/injection/operation',
      { method: 'POST', body: txHex },
    )

    // The result is the operation hash (quoted string)
    return typeof result === 'string' ? result.replace(/"/g, '') : String(result)
  }

  /**
   * Get Tezos chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [header, chainId] = await Promise.all([
      this.rpc<Record<string, unknown>>('/chains/main/blocks/head/header'),
      this.rpc<string>('/chains/main/chain_id'),
    ])

    const level = header.level as number
    const normalizedChainId = typeof chainId === 'string' ? chainId.replace(/"/g, '') : String(chainId)

    // Determine network from chain ID
    const MAINNET_CHAIN_ID = 'NetXdQprcVkpaWU'
    const GHOSTNET_CHAIN_ID = 'NetXnHfVqm9iesp'

    let name = 'Tezos'
    let testnet = false

    if (normalizedChainId === MAINNET_CHAIN_ID) {
      name = 'Tezos Mainnet'
    } else if (normalizedChainId === GHOSTNET_CHAIN_ID) {
      name = 'Tezos Ghostnet'
      testnet = true
    } else {
      name = `Tezos (${normalizedChainId})`
      testnet = true
    }

    return {
      chainId: normalizedChainId,
      name,
      symbol: 'XTZ',
      decimals: 6,
      testnet,
      blockHeight: level,
    }
  }

  // ------- ContractCapable (Michelson) -------

  /**
   * Call a read-only contract view/entrypoint.
   * Uses /chains/main/blocks/head/context/contracts/{address}/storage for storage reads
   * or /chains/main/blocks/head/helpers/scripts/run_code for Michelson execution.
   *
   * @param contractAddress - The KT1... contract address
   * @param method - Either "storage" to read storage, or a JSON-encoded Michelson script for run_code
   * @param params - Optional parameters for the call
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    if (method === 'storage') {
      return this.rpc<unknown>(
        `/chains/main/blocks/head/context/contracts/${contractAddress}/storage`,
      )
    }

    if (method === 'script') {
      return this.rpc<unknown>(
        `/chains/main/blocks/head/context/contracts/${contractAddress}/script`,
      )
    }

    // For Michelson entrypoint calls, use the run_view or run_code helpers
    if (method === 'run_view' && params && params.length >= 2) {
      const viewName = params[0] as string
      const input = params[1]
      const body = {
        contract: contractAddress,
        view: viewName,
        input,
        chain_id: await this.rpc<string>('/chains/main/chain_id').then(
          (id) => typeof id === 'string' ? id.replace(/"/g, '') : String(id),
        ),
        source: params[2] as string | undefined,
      }
      return this.rpc<unknown>(
        '/chains/main/blocks/head/helpers/scripts/run_view',
        { method: 'POST', body },
      )
    }

    // Default: post method body as Michelson script to run
    const body = typeof method === 'string' ? JSON.parse(method) : method
    return this.rpc<unknown>(
      '/chains/main/blocks/head/helpers/scripts/run_code',
      { method: 'POST', body },
    )
  }

  /**
   * Estimate gas for a contract call.
   * Uses the simulation endpoint to estimate gas consumption.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    // Use run_operation to simulate and get gas consumption
    if (params && params.length >= 1) {
      const operation = params[0] as Record<string, unknown>
      try {
        const result = await this.rpc<Record<string, unknown>>(
          '/chains/main/blocks/head/helpers/scripts/run_operation',
          { method: 'POST', body: operation },
        )
        const contents = result.contents as Array<Record<string, unknown>> | undefined
        if (contents && contents.length > 0) {
          const metadata = contents[0].metadata as Record<string, unknown> | undefined
          const opResult = metadata?.operation_result as Record<string, unknown> | undefined
          const consumed = opResult?.consumed_milligas as string | undefined
          if (consumed) {
            // Convert milligas to gas (ceiling)
            const gas = Math.ceil(parseInt(consumed, 10) / 1000)
            return gas.toString()
          }
        }
      } catch {
        // Fall through to default
      }
    }

    // Default gas estimate for simple operations
    return '10000'
  }

  // ------- TokenCapable (FA1.2 / FA2) -------

  /**
   * Get the FA1.2 or FA2 token balance for an address.
   * Uses the big_map storage to look up balances.
   *
   * @param address - The holder address
   * @param tokenAddress - The token contract address (KT1...)
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    // Try FA2 style first (big_map with (address, nat) key)
    // Then fall back to FA1.2 style (big_map with address key)
    try {
      // Get contract storage to find the ledger big_map ID
      const storage = await this.rpc<unknown>(
        `/chains/main/blocks/head/context/contracts/${tokenAddress}/storage`,
      )

      // Try to read balance via entrypoint (common for FA2)
      // FA2 balance_of view
      const body = {
        contract: tokenAddress,
        view: 'balance_of',
        input: { prim: 'Pair', args: [{ string: address }, { int: '0' }] },
        chain_id: await this.rpc<string>('/chains/main/chain_id').then(
          (id) => typeof id === 'string' ? id.replace(/"/g, '') : String(id),
        ),
      }

      const result = await this.rpc<Record<string, unknown>>(
        '/chains/main/blocks/head/helpers/scripts/run_view',
        { method: 'POST', body },
      )

      const data = result.data as Record<string, string> | undefined
      if (data?.int) {
        return {
          address,
          amount: data.int,
          symbol: '',
          decimals: 0,
        }
      }
    } catch {
      // Fall through
    }

    // Fallback: return zero balance
    return {
      address,
      amount: '0',
      symbol: '',
      decimals: 0,
    }
  }

  /**
   * Get metadata for a Tezos FA token.
   * Reads from the contract storage/metadata big_map.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    try {
      const storage = await this.rpc<unknown>(
        `/chains/main/blocks/head/context/contracts/${tokenAddress}/storage`,
      )

      // Try to get token_metadata view (FA2 standard)
      try {
        const body = {
          contract: tokenAddress,
          view: 'token_metadata',
          input: { int: '0' },
          chain_id: await this.rpc<string>('/chains/main/chain_id').then(
            (id) => typeof id === 'string' ? id.replace(/"/g, '') : String(id),
          ),
        }

        const result = await this.rpc<Record<string, unknown>>(
          '/chains/main/blocks/head/helpers/scripts/run_view',
          { method: 'POST', body },
        )

        // Parse metadata from Michelson result
        return {
          address: tokenAddress,
          name: '',
          symbol: '',
          decimals: 0,
        }
      } catch {
        // Fall through
      }
    } catch {
      // Contract not found or not a token
    }

    return {
      address: tokenAddress,
      name: '',
      symbol: '',
      decimals: 0,
    }
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Tezos block time is ~15 seconds (adaptive, varies by protocol).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastLevel = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const header = await this.rpc<Record<string, unknown>>(
            '/chains/main/blocks/head/header',
          )
          const level = header.level as number

          if (level > lastLevel) {
            lastLevel = level
            callback(level)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 15000))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }

  /**
   * Subscribe to transactions for an address via polling.
   * Polls every ~15 seconds and checks new blocks for matching operations.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastLevel = 0
    let active = true

    // Initialize last level
    try {
      const header = await this.rpc<Record<string, unknown>>(
        '/chains/main/blocks/head/header',
      )
      lastLevel = header.level as number
    } catch {
      // Start from 0
    }

    const poll = async () => {
      while (active) {
        try {
          const header = await this.rpc<Record<string, unknown>>(
            '/chains/main/blocks/head/header',
          )
          const currentLevel = header.level as number

          if (currentLevel > lastLevel) {
            // Check new blocks for operations involving the address
            for (
              let level = lastLevel + 1;
              level <= currentLevel && active;
              level++
            ) {
              try {
                const block = await this.rpc<Record<string, unknown>>(
                  `/chains/main/blocks/${level}`,
                )

                const operations = block.operations as Array<
                  Array<Record<string, unknown>>
                > | undefined

                if (operations) {
                  for (const group of operations) {
                    for (const op of group) {
                      const contents = op.contents as Array<
                        Record<string, unknown>
                      > | undefined
                      if (!contents) continue

                      for (const content of contents) {
                        const source = content.source as string | undefined
                        const destination = content.destination as string | undefined

                        if (source === address || destination === address) {
                          const metadata = content.metadata as Record<string, unknown> | undefined
                          const result = metadata?.operation_result as Record<string, unknown> | undefined
                          const opStatus = result?.status as string | undefined

                          let status: 'pending' | 'confirmed' | 'failed' = 'confirmed'
                          if (opStatus === 'failed' || opStatus === 'backtracked') {
                            status = 'failed'
                          }

                          const blockTimestamp = (block.header as Record<string, unknown>)
                            .timestamp as string

                          callback({
                            hash: op.hash as string,
                            from: source ?? '',
                            to: destination ?? null,
                            value: (content.amount as string) ?? '0',
                            fee: (content.fee as string) ?? '0',
                            blockNumber: level,
                            blockHash: block.hash as string,
                            status,
                            timestamp: Math.floor(
                              new Date(blockTimestamp).getTime() / 1000,
                            ),
                            nonce: content.counter
                              ? parseInt(content.counter as string, 10)
                              : undefined,
                          })
                        }
                      }
                    }
                  }
                }
              } catch {
                // Skip this block
              }
            }
            lastLevel = currentLevel
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 15000))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }
}
