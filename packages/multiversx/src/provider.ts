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
 * Configuration for the MultiversX provider.
 */
export interface MultiversXProviderConfig {
  /** Base URL for the MultiversX API (e.g., "https://api.multiversx.com" or "https://testnet-api.multiversx.com") */
  apiUrl: string
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
}

/**
 * MultiversX provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses the MultiversX REST API (Gateway/API pattern).
 */
export class MultiversXProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly apiUrl: string
  private readonly timeout: number

  constructor(config: MultiversXProviderConfig) {
    // Remove trailing slash
    this.apiUrl = config.apiUrl.replace(/\/+$/, '')
    this.timeout = config.timeout ?? 10000
  }

  /**
   * Make a GET request to the MultiversX API.
   */
  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText)
        throw new ChainKitError(
          ErrorCode.RPC_ERROR,
          `MultiversX API error (${response.status}): ${text}`,
        )
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ChainKitError(ErrorCode.TIMEOUT, 'MultiversX API request timed out')
      }
      throw new ChainKitError(
        ErrorCode.RPC_ERROR,
        `MultiversX API request failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Make a POST request to the MultiversX API.
   */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText)
        throw new ChainKitError(
          ErrorCode.RPC_ERROR,
          `MultiversX API error (${response.status}): ${text}`,
        )
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ChainKitError(ErrorCode.TIMEOUT, 'MultiversX API request timed out')
      }
      throw new ChainKitError(
        ErrorCode.RPC_ERROR,
        `MultiversX API request failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // ------- ChainProvider -------

  /**
   * Get the EGLD balance of an address.
   * Uses GET /accounts/{address}
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.get<{ balance: string }>(`/accounts/${address}`)

    return {
      address,
      amount: result.balance,
      symbol: 'EGLD',
      decimals: 18,
    }
  }

  /**
   * Get transaction details by hash.
   * Uses GET /transactions/{hash}
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const tx = await this.get<{
        txHash: string
        sender: string
        receiver: string
        value: string
        fee: string
        gasPrice: number
        gasLimit: number
        gasUsed?: number
        miniBlockHash?: string
        blockNonce?: number
        blockHash?: string
        status: string
        timestamp: number
        nonce: number
        data?: string
      }>(`/transactions/${hash}`)

      let status: 'pending' | 'confirmed' | 'failed' = 'pending'
      if (tx.status === 'success') {
        status = 'confirmed'
      } else if (tx.status === 'fail' || tx.status === 'invalid') {
        status = 'failed'
      }

      return {
        hash: tx.txHash,
        from: tx.sender,
        to: tx.receiver,
        value: tx.value,
        fee: tx.fee ?? '0',
        blockNumber: tx.blockNonce ?? null,
        blockHash: tx.blockHash ?? null,
        status,
        timestamp: tx.timestamp ?? null,
        nonce: tx.nonce,
      }
    } catch (err) {
      if (
        err instanceof ChainKitError &&
        err.code === ErrorCode.RPC_ERROR &&
        err.message.includes('404')
      ) {
        return null
      }
      throw err
    }
  }

  /**
   * Get block details by nonce (block number) or hash.
   * Uses GET /blocks/by-nonce/{nonce} or GET /blocks/{hash}
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      let block: {
        nonce: number
        hash: string
        prevHash: string
        timestamp: number
        numTxs: number
        miniBlocks?: Array<{ hash: string; txHashes?: string[] }>
      }

      if (typeof hashOrNumber === 'number') {
        block = await this.get(`/blocks/by-nonce/${hashOrNumber}?withTxs=true`)
      } else {
        // Try parsing as a number first
        const asNumber = parseInt(hashOrNumber, 10)
        if (!isNaN(asNumber) && String(asNumber) === hashOrNumber) {
          block = await this.get(`/blocks/by-nonce/${asNumber}?withTxs=true`)
        } else {
          // Treat as block hash
          block = await this.get(`/blocks/${hashOrNumber}?withTxs=true`)
        }
      }

      // Extract transaction hashes from miniblocks
      const transactions: string[] = []
      if (block.miniBlocks) {
        for (const mb of block.miniBlocks) {
          if (mb.txHashes) {
            transactions.push(...mb.txHashes)
          }
        }
      }

      return {
        number: block.nonce,
        hash: block.hash,
        parentHash: block.prevHash,
        timestamp: block.timestamp,
        transactions,
      }
    } catch (err) {
      if (
        err instanceof ChainKitError &&
        err.code === ErrorCode.RPC_ERROR &&
        err.message.includes('404')
      ) {
        return null
      }
      throw err
    }
  }

  /**
   * Estimate transaction fees on MultiversX.
   * Uses GET /network/config for gas settings.
   */
  async estimateFee(): Promise<FeeEstimate> {
    const config = await this.get<{
      config: {
        erd_min_gas_price: number
        erd_min_gas_limit: number
        erd_gas_per_data_byte: number
      }
    }>('/network/config')

    const minGasPrice = config.config.erd_min_gas_price
    const minGasLimit = config.config.erd_min_gas_limit

    // Base fee = minGasLimit * minGasPrice
    const baseFee = BigInt(minGasLimit) * BigInt(minGasPrice)

    return {
      slow: baseFee.toString(),
      average: baseFee.toString(),
      fast: baseFee.toString(),
      unit: 'atto-EGLD',
    }
  }

  /**
   * Broadcast a signed transaction to the MultiversX network.
   * Uses POST /transactions
   * The signedTx should be a JSON string of the signed transaction object.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    // signedTx is expected to be a JSON-serialized transaction with signature field
    let txObj: unknown
    try {
      txObj = JSON.parse(signedTx)
    } catch {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'signedTx must be a JSON-serialized transaction object',
      )
    }

    const result = await this.post<{ txHash: string }>('/transactions', txObj)
    return result.txHash
  }

  /**
   * Get MultiversX chain/network information.
   * Uses GET /network/config and GET /network/status/4294967295
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [configResult, statusResult] = await Promise.all([
      this.get<{
        config: {
          erd_chain_id: string
          erd_denomination: number
        }
      }>('/network/config'),
      this.get<{
        status: {
          erd_nonce: number
          erd_current_round: number
        }
      }>('/network/status/4294967295'),
    ])

    const chainId = configResult.config.erd_chain_id

    // Determine network name and testnet status from chainId
    let name = 'MultiversX'
    let testnet = false

    if (chainId === '1') {
      name = 'MultiversX Mainnet'
    } else if (chainId === 'T') {
      name = 'MultiversX Testnet'
      testnet = true
    } else if (chainId === 'D') {
      name = 'MultiversX Devnet'
      testnet = true
    } else {
      name = `MultiversX (Chain ${chainId})`
      testnet = true
    }

    return {
      chainId,
      name,
      symbol: 'EGLD',
      decimals: 18,
      testnet,
      blockHeight: statusResult.status.erd_nonce,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only smart contract method via VM query.
   * Uses POST /vm-values/query
   * @param contractAddress - The smart contract address
   * @param method - The function name to call
   * @param params - Hex-encoded arguments
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      scAddress: contractAddress,
      funcName: method,
      args: (params as string[]) ?? [],
    }

    const result = await this.post<{
      data: {
        returnData: string[] | null
        returnCode: string
        returnMessage: string
      }
    }>('/vm-values/query', body)

    if (result.data.returnCode !== 'ok') {
      throw new ChainKitError(
        ErrorCode.TRANSACTION_FAILED,
        `VM query failed: ${result.data.returnMessage}`,
        { contractAddress, method, returnCode: result.data.returnCode },
      )
    }

    return result.data
  }

  /**
   * Estimate gas for a contract call.
   * Uses POST /transaction/cost
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    // Build a transaction for cost estimation
    const body = {
      receiver: contractAddress,
      sender: contractAddress, // Placeholder, cost estimation doesn't require valid sender
      value: '0',
      data: btoa(method),
      chainID: '1',
      version: 1,
    }

    try {
      const result = await this.post<{
        txGasUnits: number
      }>('/transaction/cost', body)

      return result.txGasUnits.toString()
    } catch {
      // Default gas limit for smart contract calls
      return '6000000'
    }
  }

  // ------- TokenCapable -------

  /**
   * Get the ESDT token balance for an address.
   * Uses GET /accounts/{address}/tokens/{tokenIdentifier}
   * @param address - The holder address
   * @param tokenAddress - The ESDT token identifier (e.g., "USDC-c76f1f")
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    try {
      const result = await this.get<{
        identifier: string
        balance: string
        decimals: number
        ticker?: string
      }>(`/accounts/${address}/tokens/${tokenAddress}`)

      return {
        address,
        amount: result.balance,
        symbol: result.ticker ?? result.identifier,
        decimals: result.decimals,
      }
    } catch (err) {
      if (
        err instanceof ChainKitError &&
        err.code === ErrorCode.RPC_ERROR &&
        err.message.includes('404')
      ) {
        // Token not found for this address - zero balance
        return {
          address,
          amount: '0',
          symbol: '',
          decimals: 0,
        }
      }
      throw err
    }
  }

  /**
   * Get metadata for an ESDT token.
   * Uses GET /tokens/{tokenIdentifier}
   * @param tokenAddress - The ESDT token identifier
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const result = await this.get<{
      identifier: string
      name: string
      ticker: string
      decimals: number
      supply?: string
      initialMinted?: string
    }>(`/tokens/${tokenAddress}`)

    return {
      address: tokenAddress,
      name: result.name,
      symbol: result.ticker,
      decimals: result.decimals,
      totalSupply: result.supply ?? result.initialMinted,
    }
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Polls the network status endpoint for new block nonces.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastNonce = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const status = await this.get<{
            status: {
              erd_nonce: number
            }
          }>('/network/status/4294967295')

          const currentNonce = status.status.erd_nonce
          if (currentNonce > lastNonce) {
            lastNonce = currentNonce
            callback(currentNonce)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 6000)) // MultiversX ~6s block time
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
   * Polls for new transactions on the given address.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastTimestamp = Math.floor(Date.now() / 1000)
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const txs = await this.get<
            Array<{
              txHash: string
              sender: string
              receiver: string
              value: string
              fee: string
              status: string
              timestamp: number
              nonce: number
              blockNonce?: number
              blockHash?: string
            }>
          >(`/accounts/${address}/transactions?after=${lastTimestamp}&size=25`)

          if (txs && txs.length > 0) {
            // Process in chronological order
            const sorted = [...txs].sort((a, b) => a.timestamp - b.timestamp)
            for (const tx of sorted) {
              if (tx.timestamp > lastTimestamp) {
                let status: 'pending' | 'confirmed' | 'failed' = 'pending'
                if (tx.status === 'success') status = 'confirmed'
                else if (tx.status === 'fail' || tx.status === 'invalid') status = 'failed'

                callback({
                  hash: tx.txHash,
                  from: tx.sender,
                  to: tx.receiver,
                  value: tx.value,
                  fee: tx.fee ?? '0',
                  blockNumber: tx.blockNonce ?? null,
                  blockHash: tx.blockHash ?? null,
                  status,
                  timestamp: tx.timestamp,
                  nonce: tx.nonce,
                })
              }
            }
            lastTimestamp = sorted[sorted.length - 1].timestamp
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
