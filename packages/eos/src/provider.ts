import {
  ChainKitError,
  ErrorCode,
  waitForTransaction as waitForTransactionHelper,
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
  WaitForTransactionOptions,
  BlockInfo,
  ChainInfo,
  HexString,
  TokenMetadata,
  Unsubscribe,
} from '@chainkit/core'
import type {
  EosChainInfoResponse,
  EosAccountResponse,
  EosBlockResponse,
  EosCurrencyStats,
  EosTableRowsResponse,
} from './types.js'

/**
 * Configuration for the EOS provider.
 */
export interface EosProviderConfig {
  /** List of EOSIO REST API endpoint URLs (e.g., "https://eos.greymass.com") */
  endpoints: string[]
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
  /** Number of retries per endpoint (default: 2) */
  retries?: number
}

/**
 * Simple REST client for EOSIO Chain API.
 * EOSIO uses REST (POST with JSON body) instead of JSON-RPC.
 */
class EosRestClient {
  private readonly endpoints: string[]
  private readonly timeout: number
  private readonly retries: number
  private currentIndex = 0

  constructor(config: EosProviderConfig) {
    if (!config.endpoints || config.endpoints.length === 0) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'At least one EOSIO endpoint is required')
    }
    this.endpoints = config.endpoints.map((e) => e.replace(/\/$/, ''))
    this.timeout = config.timeout ?? 10000
    this.retries = config.retries ?? 2
  }

  /**
   * Make a POST request to an EOSIO REST API endpoint.
   */
  async post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const errors: Error[] = []

    for (let i = 0; i < this.endpoints.length; i++) {
      const endpointIdx = (this.currentIndex + i) % this.endpoints.length
      const endpoint = this.endpoints[endpointIdx]
      const url = `${endpoint}${path}`

      try {
        const result = await this.postWithRetries<T>(url, body)
        this.currentIndex = endpointIdx
        return result
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
        if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
          throw err
        }
      }
    }

    throw new ChainKitError(ErrorCode.RPC_ALL_FAILED, 'All EOSIO endpoints failed', {
      errors: errors.map((e) => e.message),
    })
  }

  private async postWithRetries<T>(url: string, body?: Record<string, unknown>): Promise<T> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.postSingle<T>(url, body)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
          throw err
        }
      }
    }

    throw lastError!
  }

  private async postSingle<T>(url: string, body?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : '{}',
        signal: controller.signal,
      })

      const json = await response.json() as T & { error?: { code: number; message: string; details?: unknown } }

      if (!response.ok || (json as Record<string, unknown>).error) {
        const err = (json as Record<string, unknown>).error as Record<string, unknown> | undefined
        const message = err
          ? `${(err.what as string) ?? (err.message as string) ?? 'Unknown EOSIO error'}`
          : `HTTP ${response.status}: ${response.statusText}`
        throw new ChainKitError(ErrorCode.RPC_ERROR, message, {
          url,
          status: response.status,
          error: err,
        })
      }

      return json
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${url} timed out`, {
          url,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(ErrorCode.NETWORK_ERROR, `Request to ${url} failed: ${(err as Error).message}`, {
        url,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  getEndpoints(): string[] {
    return [...this.endpoints]
  }
}

/**
 * Parse an EOS asset string like "100.0000 EOS" into amount and symbol.
 */
function parseEosAsset(asset: string): { amount: string; symbol: string; decimals: number } {
  const parts = asset.trim().split(' ')
  if (parts.length !== 2) {
    throw new ChainKitError(ErrorCode.INVALID_PARAMS, `Invalid EOS asset format: "${asset}"`)
  }

  const [amountStr, symbol] = parts
  const dotIdx = amountStr.indexOf('.')
  const decimals = dotIdx >= 0 ? amountStr.length - dotIdx - 1 : 0

  // Convert to smallest unit (e.g., "1.0000" -> "10000")
  const wholePart = dotIdx >= 0 ? amountStr.slice(0, dotIdx) : amountStr
  const fracPart = dotIdx >= 0 ? amountStr.slice(dotIdx + 1) : ''
  const amount = wholePart + fracPart

  return { amount, symbol, decimals }
}

/**
 * EOS provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses EOSIO REST API endpoints to interact with EOS nodes.
 */
export class EosProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly client: EosRestClient

  constructor(config: EosProviderConfig) {
    this.client = new EosRestClient(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the EOS balance of an account.
   * @param address - The EOS account name (e.g., "myaccount123")
   */
  async getBalance(address: Address): Promise<Balance> {
    const account = await this.client.post<EosAccountResponse>(
      '/v1/chain/get_account',
      { account_name: address },
    )

    if (!account.core_liquid_balance) {
      return {
        address,
        amount: '0',
        symbol: 'EOS',
        decimals: 4,
      }
    }

    const parsed = parseEosAsset(account.core_liquid_balance)
    return {
      address,
      amount: parsed.amount,
      symbol: parsed.symbol,
      decimals: parsed.decimals,
    }
  }

  /**
   * Get transaction details by ID.
   * Uses the /v1/history/get_transaction endpoint.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const result = await this.client.post<{
        id: string
        trx: {
          receipt: {
            status: string
            cpu_usage_us: number
            net_usage_words: number
          }
          trx: {
            actions: Array<{
              account: string
              name: string
              authorization: Array<{ actor: string; permission: string }>
              data: Record<string, unknown>
            }>
          }
        }
        block_num: number
        block_time: string
      }>('/v1/history/get_transaction', { id: hash })

      const actions = result.trx.trx.actions
      const firstAction = actions[0]

      // Extract from/to/value from transfer actions
      let from = ''
      let to: string | null = null
      let value = '0'

      if (firstAction?.name === 'transfer' && firstAction.data) {
        from = (firstAction.data.from as string) ?? ''
        to = (firstAction.data.to as string) ?? null
        const quantity = firstAction.data.quantity as string | undefined
        if (quantity) {
          const parsed = parseEosAsset(quantity)
          value = parsed.amount
        }
      } else if (firstAction) {
        from = firstAction.authorization[0]?.actor ?? ''
      }

      const receipt = result.trx.receipt
      const status: 'pending' | 'confirmed' | 'failed' =
        receipt.status === 'executed' ? 'confirmed' : 'failed'

      const fee = `${receipt.cpu_usage_us}`

      return {
        hash: result.id,
        from,
        to,
        value,
        fee,
        blockNumber: result.block_num,
        blockHash: null,
        status,
        timestamp: Math.floor(new Date(result.block_time + 'Z').getTime() / 1000),
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get block details by number or ID.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      const params: Record<string, unknown> =
        typeof hashOrNumber === 'number'
          ? { block_num_or_id: hashOrNumber }
          : { block_num_or_id: hashOrNumber }

      const block = await this.client.post<EosBlockResponse>(
        '/v1/chain/get_block',
        params,
      )

      const txHashes = block.transactions.map((t) => {
        if (typeof t.trx === 'string') return t.trx
        return t.trx.id
      })

      return {
        number: block.block_num,
        hash: block.id,
        parentHash: block.previous,
        timestamp: Math.floor(new Date(block.timestamp + 'Z').getTime() / 1000),
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
   * Get the head block number as a sequence proxy for EOS (EOS has no per-account nonce).
   * Returns the head block number from chain info.
   */
  async getNonce(address: Address): Promise<number> {
    try {
      const account = await this.client.post<{ head_block_num?: number }>('/v1/chain/get_account', { account_name: address })
      return account.head_block_num ?? 0
    } catch {
      return 0
    }
  }

  /**
   * Estimate resource costs.
   * EOS does not have traditional gas fees; it uses CPU/NET/RAM resources.
   * Returns resource price estimates.
   */
  async estimateFee(): Promise<FeeEstimate> {
    const info = await this.client.post<EosChainInfoResponse>('/v1/chain/get_info')

    // EOS resource costs are based on staking, not direct fees
    // Return resource limits as a proxy for fee estimation
    const cpuLimit = info.virtual_block_cpu_limit
    const netLimit = info.virtual_block_net_limit

    return {
      slow: '0',
      average: '0',
      fast: '0',
      unit: 'staked',
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   * @param signedTx - JSON string of the signed transaction
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    // signedTx is expected to be a JSON string with { signatures, compression, packed_trx, packed_context_free_data }
    const txData = JSON.parse(signedTx)

    const result = await this.client.post<{ transaction_id: string; processed: unknown }>(
      '/v1/chain/push_transaction',
      txData,
    )

    return result.transaction_id
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const info = await this.client.post<EosChainInfoResponse>('/v1/chain/get_info')

    // Known chain IDs
    const knownChains: Record<string, { name: string; testnet: boolean }> = {
      'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906': {
        name: 'EOS Mainnet',
        testnet: false,
      },
      'e70aaab8997e1dfce58fbfac80cbbb8fecec7b99cf982a9444273cbc64c41473': {
        name: 'EOS Jungle Testnet',
        testnet: true,
      },
      '5fff1dae8dc8e2fc4d5b23b2c7665c97f9e9d8edf2b6485a86ba311c25639191': {
        name: 'EOS Kylin Testnet',
        testnet: true,
      },
    }

    const chainInfo = knownChains[info.chain_id] ?? {
      name: `EOSIO Chain ${info.chain_id.slice(0, 8)}`,
      testnet: false,
    }

    return {
      chainId: info.chain_id,
      name: chainInfo.name,
      symbol: 'EOS',
      decimals: 4,
      testnet: chainInfo.testnet,
      blockHeight: info.head_block_num,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only contract method via get_table_rows.
   * @param contractAddress - The contract account name
   * @param method - Table name to query, or JSON string with full params
   * @param params - [scope, limit, lower_bound, upper_bound, key_type, index_position]
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // If method looks like JSON, parse it for full table query params
    if (method.startsWith('{')) {
      const queryParams = JSON.parse(method)
      return this.client.post('/v1/chain/get_table_rows', {
        json: true,
        code: contractAddress,
        ...queryParams,
      })
    }

    // Simple table query
    const scope = (params?.[0] as string) ?? contractAddress
    const limit = (params?.[1] as number) ?? 10
    const lowerBound = params?.[2] as string | undefined
    const upperBound = params?.[3] as string | undefined

    const query: Record<string, unknown> = {
      json: true,
      code: contractAddress,
      scope,
      table: method,
      limit,
    }

    if (lowerBound !== undefined) query.lower_bound = lowerBound
    if (upperBound !== undefined) query.upper_bound = upperBound

    return this.client.post<EosTableRowsResponse>('/v1/chain/get_table_rows', query)
  }

  /**
   * Estimate resource usage for a contract call.
   * Returns estimated CPU usage in microseconds as a string.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    // EOSIO doesn't have gas estimation like Ethereum.
    // We return the block CPU limit as a baseline estimate.
    const info = await this.client.post<EosChainInfoResponse>('/v1/chain/get_info')
    return info.block_cpu_limit.toString()
  }

  // ------- TokenCapable -------

  /**
   * Get the balance of a specific token for an account.
   * @param address - The account name
   * @param tokenAddress - The token contract account (e.g., "eosio.token")
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    // Get currency balance via the chain API
    const balances = await this.client.post<string[]>(
      '/v1/chain/get_currency_balance',
      {
        code: tokenAddress,
        account: address,
      },
    )

    if (!balances || balances.length === 0) {
      return {
        address,
        amount: '0',
        symbol: 'UNKNOWN',
        decimals: 4,
      }
    }

    // Parse the first balance (format: "100.0000 EOS")
    const parsed = parseEosAsset(balances[0])
    return {
      address,
      amount: parsed.amount,
      symbol: parsed.symbol,
      decimals: parsed.decimals,
    }
  }

  /**
   * Get metadata for a token.
   * @param tokenAddress - The token contract account (e.g., "eosio.token")
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    // Get currency stats to find symbol info
    // We need to know the symbol to query stats, so we query the stat table directly
    const statTable = await this.client.post<EosTableRowsResponse<{
      supply: string
      max_supply: string
      issuer: string
    }>>('/v1/chain/get_table_rows', {
      json: true,
      code: tokenAddress,
      scope: 'EOS', // Default scope, might need adjustment per token
      table: 'stat',
      limit: 1,
    })

    if (statTable.rows.length === 0) {
      // Try without specific scope
      return {
        address: tokenAddress,
        name: tokenAddress,
        symbol: 'UNKNOWN',
        decimals: 4,
        totalSupply: '0',
      }
    }

    const stat = statTable.rows[0]
    const parsed = parseEosAsset(stat.supply)

    return {
      address: tokenAddress,
      name: tokenAddress,
      symbol: parsed.symbol,
      decimals: parsed.decimals,
      totalSupply: parsed.amount,
    }
  }

  /**
   * Get balances for multiple tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * EOS produces blocks every 0.5 seconds.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const info = await this.client.post<EosChainInfoResponse>('/v1/chain/get_info')
          const blockNumber = info.head_block_num

          if (blockNumber > lastBlockNumber) {
            lastBlockNumber = blockNumber
            callback(blockNumber)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }

  /**
   * Subscribe to transactions for an account via polling.
   * Polls for new blocks and checks for actions involving the account.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const info = await this.client.post<EosChainInfoResponse>('/v1/chain/get_info')
          const currentBlock = info.head_block_num

          if (currentBlock > lastBlockNumber) {
            for (
              let blockNum = lastBlockNumber + 1;
              blockNum <= currentBlock && active;
              blockNum++
            ) {
              try {
                const block = await this.client.post<EosBlockResponse>(
                  '/v1/chain/get_block',
                  { block_num_or_id: blockNum },
                )

                for (const trx of block.transactions) {
                  if (typeof trx.trx !== 'string' && trx.trx.id) {
                    const txInfo = await this.getTransaction(trx.trx.id)
                    if (txInfo && (txInfo.from === address || txInfo.to === address)) {
                      callback(txInfo)
                    }
                  }
                }
              } catch {
                // Skip blocks that fail to fetch
              }
            }
            lastBlockNumber = currentBlock
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    }

    // Initialize lastBlockNumber
    try {
      const info = await this.client.post<EosChainInfoResponse>('/v1/chain/get_info')
      lastBlockNumber = info.head_block_num
    } catch {
      // Start from 0
    }

    poll()

    return () => {
      active = false
    }
  }

  // ------- waitForTransaction -------

  /**
   * Wait for a transaction to be confirmed on-chain.
   * Polls getTransaction until the status is 'confirmed' or 'failed'.
   */
  async waitForTransaction(
    hash: string,
    options?: WaitForTransactionOptions,
  ): Promise<TransactionInfo> {
    return waitForTransactionHelper(
      (h) => this.getTransaction(h) as Promise<TransactionInfo>,
      hash,
      options,
    )
  }
}
