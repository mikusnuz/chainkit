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
 * Configuration for the Hedera provider.
 * Uses the Hedera Mirror Node REST API instead of JSON-RPC.
 */
export interface HederaMirrorNodeConfig {
  /** Mirror Node base URL (e.g., "https://testnet.mirrornode.hedera.com") */
  baseUrl: string
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
}

/**
 * Hedera provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses the Hedera Mirror Node REST API to interact with the Hedera network.
 */
export class HederaProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly baseUrl: string
  private readonly timeout: number

  constructor(config: HederaMirrorNodeConfig) {
    // Remove trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.timeout = config.timeout ?? 10000
  }

  /**
   * Make an HTTP GET request to the Mirror Node API.
   */
  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new ChainKitError(
          ErrorCode.RPC_ERROR,
          `Mirror Node request failed: ${response.status} ${response.statusText} - ${body}`,
          { url, status: response.status },
        )
      }

      return (await response.json()) as T
    } catch (error) {
      if (error instanceof ChainKitError) throw error
      if ((error as Error).name === 'AbortError') {
        throw new ChainKitError(
          ErrorCode.RPC_ERROR,
          `Mirror Node request timed out after ${this.timeout}ms`,
          { url },
        )
      }
      throw new ChainKitError(
        ErrorCode.RPC_ERROR,
        `Mirror Node request failed: ${(error as Error).message}`,
        { url },
      )
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Make an HTTP POST request to the Mirror Node API.
   */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const responseBody = await response.text().catch(() => '')
        throw new ChainKitError(
          ErrorCode.RPC_ERROR,
          `Mirror Node request failed: ${response.status} ${response.statusText} - ${responseBody}`,
          { url, status: response.status },
        )
      }

      return (await response.json()) as T
    } catch (error) {
      if (error instanceof ChainKitError) throw error
      if ((error as Error).name === 'AbortError') {
        throw new ChainKitError(
          ErrorCode.RPC_ERROR,
          `Mirror Node request timed out after ${this.timeout}ms`,
          { url },
        )
      }
      throw new ChainKitError(
        ErrorCode.RPC_ERROR,
        `Mirror Node request failed: ${(error as Error).message}`,
        { url },
      )
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // ------- ChainProvider -------

  /**
   * Get the HBAR balance of an account.
   * @param address - The account ID (e.g., "0.0.12345") or public key alias
   */
  async getBalance(address: Address): Promise<Balance> {
    const account = await this.get<{
      account: string
      balance: { balance: number; timestamp: string }
    }>(`/api/v1/accounts/${address}`)

    return {
      address,
      amount: account.balance.balance.toString(),
      symbol: 'HBAR',
      decimals: 8,
    }
  }

  /**
   * Get transaction details by transaction ID.
   * @param hash - The transaction ID (e.g., "0.0.12345-1234567890-123456789")
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const result = await this.get<{
        transactions: Array<{
          transaction_id: string
          consensus_timestamp: string
          charged_tx_fee: number
          max_fee: string
          result: string
          name: string
          node: string
          transfers: Array<{ account: string; amount: number }>
          valid_start_timestamp: string
          memo_base64: string
          transaction_hash: string
          nonce: number
        }>
      }>(`/api/v1/transactions/${hash}`)

      if (!result.transactions || result.transactions.length === 0) {
        return null
      }

      const tx = result.transactions[0]

      // Determine from/to from transfers
      // The sender has the largest negative transfer, the receiver has the largest positive one
      let from = ''
      let to: string | null = null
      let value = '0'
      let largestNegative = 0
      let largestPositive = 0

      for (const transfer of tx.transfers) {
        if (transfer.amount < largestNegative) {
          largestNegative = transfer.amount
          from = transfer.account
        }
        if (transfer.amount > largestPositive) {
          largestPositive = transfer.amount
          to = transfer.account
          value = transfer.amount.toString()
        }
      }

      // Determine status
      let status: 'pending' | 'confirmed' | 'failed' = 'confirmed'
      if (tx.result !== 'SUCCESS') {
        status = 'failed'
      }

      // Parse timestamp
      const timestampParts = tx.consensus_timestamp.split('.')
      const timestamp = parseInt(timestampParts[0], 10)

      return {
        hash: tx.transaction_id,
        from,
        to,
        value,
        fee: tx.charged_tx_fee.toString(),
        blockNumber: null,
        blockHash: null,
        status,
        timestamp,
        nonce: tx.nonce,
      }
    } catch (error) {
      if (error instanceof ChainKitError && error.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw error
    }
  }

  /**
   * Get block details by number.
   * On Hedera, blocks map to record files; we use the /api/v1/blocks endpoint.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      const block = await this.get<{
        number: number
        hash: string
        previous_hash: string
        timestamp: { from: string; to: string }
        count: number
      }>(`/api/v1/blocks/${hashOrNumber}`)

      if (!block) return null

      // Parse timestamp
      const timestampParts = block.timestamp.from.split('.')
      const timestamp = parseInt(timestampParts[0], 10)

      return {
        number: block.number,
        hash: block.hash,
        parentHash: block.previous_hash,
        timestamp,
        transactions: [],
      }
    } catch (error) {
      if (error instanceof ChainKitError && error.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw error
    }
  }

  /**
   * Estimate transaction fees on Hedera.
   * Hedera has deterministic fees; we return typical fee ranges.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Hedera has relatively fixed fees
    // Crypto transfer: ~0.0001 HBAR = 10000 tinybar
    // Smart contract call: variable based on gas
    try {
      const networkInfo = await this.get<{
        fees: Array<{
          gas: number
          transaction_type: string
        }>
      }>('/api/v1/network/fees')

      if (networkInfo.fees && networkInfo.fees.length > 0) {
        const fees = networkInfo.fees.map((f) => f.gas).filter((g) => g > 0)
        if (fees.length > 0) {
          fees.sort((a, b) => a - b)
          return {
            slow: fees[0].toString(),
            average: fees[Math.floor(fees.length / 2)].toString(),
            fast: fees[fees.length - 1].toString(),
            unit: 'tinybar',
          }
        }
      }
    } catch {
      // Fall through to defaults
    }

    // Default fee estimates for crypto transfers
    return {
      slow: '10000',
      average: '50000',
      fast: '100000',
      unit: 'tinybar',
    }
  }

  /**
   * Broadcast a signed transaction to the Hedera network.
   * Expects a hex-encoded signed transaction.
   * Note: Direct submission via Mirror Node is limited; typically done via Hedera SDK.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const result = await this.post<{
      transactionId: string
    }>('/api/v1/transactions', {
      transaction: signedTx,
    })

    return result.transactionId
  }

  /**
   * Get Hedera network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [networkInfo, blocksInfo] = await Promise.all([
      this.get<{
        unreachable_nodes: Array<unknown>
      }>('/api/v1/network/nodes?limit=1').catch(() => null),
      this.get<{
        blocks: Array<{ number: number }>
      }>('/api/v1/blocks?limit=1&order=desc').catch(() => null),
    ])

    // Determine network from base URL
    const isTestnet = this.baseUrl.includes('testnet')
    const isPreviewnet = this.baseUrl.includes('previewnet')
    let name = 'Hedera Mainnet'
    let testnet = false

    if (isTestnet) {
      name = 'Hedera Testnet'
      testnet = true
    } else if (isPreviewnet) {
      name = 'Hedera Previewnet'
      testnet = true
    }

    const blockHeight = blocksInfo?.blocks?.[0]?.number ?? 0

    return {
      chainId: 'hedera',
      name,
      symbol: 'HBAR',
      decimals: 8,
      testnet,
      blockHeight,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only smart contract method.
   * Uses the Mirror Node /api/v1/contracts/call endpoint.
   * @param contractAddress - The contract ID (e.g., "0.0.12345") or EVM address
   * @param method - Hex-encoded call data
   * @param params - Optional parameters (unused, data should be pre-encoded)
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    const callData = method.startsWith('0x') ? method : `0x${method}`

    const result = await this.post<{
      result: string
    }>('/api/v1/contracts/call', {
      data: callData,
      to: contractAddress,
      estimate: false,
    })

    return result.result
  }

  /**
   * Estimate gas for a smart contract call.
   * Uses the Mirror Node /api/v1/contracts/call endpoint with estimate flag.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    const callData = method.startsWith('0x') ? method : `0x${method}`

    const result = await this.post<{
      result: string
    }>('/api/v1/contracts/call', {
      data: callData,
      to: contractAddress,
      estimate: true,
    })

    // result is hex-encoded gas estimate
    const gas = result.result
    if (gas.startsWith('0x')) {
      return parseInt(gas, 16).toString()
    }
    return gas
  }

  // ------- TokenCapable -------

  /**
   * Get the balance of a specific HTS (Hedera Token Service) token for an account.
   * @param address - The account ID (e.g., "0.0.12345")
   * @param tokenAddress - The token ID (e.g., "0.0.67890")
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    try {
      const result = await this.get<{
        tokens: Array<{
          token_id: string
          balance: number
          decimals: number
        }>
      }>(`/api/v1/accounts/${address}/tokens?token.id=${tokenAddress}`)

      if (!result.tokens || result.tokens.length === 0) {
        return {
          address,
          amount: '0',
          symbol: '',
          decimals: 0,
        }
      }

      const token = result.tokens[0]

      // Fetch token metadata for symbol
      let symbol = ''
      try {
        const tokenInfo = await this.get<{ symbol: string }>(`/api/v1/tokens/${tokenAddress}`)
        symbol = tokenInfo.symbol
      } catch {
        // Symbol not available
      }

      return {
        address,
        amount: token.balance.toString(),
        symbol,
        decimals: token.decimals,
      }
    } catch {
      return {
        address,
        amount: '0',
        symbol: '',
        decimals: 0,
      }
    }
  }

  /**
   * Get metadata for a Hedera Token Service (HTS) token.
   * @param tokenAddress - The token ID (e.g., "0.0.67890")
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const token = await this.get<{
      token_id: string
      name: string
      symbol: string
      decimals: string
      total_supply: string
      type: string
    }>(`/api/v1/tokens/${tokenAddress}`)

    return {
      address: token.token_id,
      name: token.name,
      symbol: token.symbol,
      decimals: parseInt(token.decimals, 10),
      totalSupply: token.total_supply,
    }
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Hedera produces blocks roughly every 1-2 seconds.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const result = await this.get<{
            blocks: Array<{ number: number }>
          }>('/api/v1/blocks?limit=1&order=desc')

          if (result.blocks && result.blocks.length > 0) {
            const blockNumber = result.blocks[0].number
            if (blockNumber > lastBlockNumber) {
              lastBlockNumber = blockNumber
              callback(blockNumber)
            }
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 3000))
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
   * Polls every 3 seconds for new transactions.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastTimestamp = ''
    let active = true

    // Get the most recent transaction timestamp to start from
    try {
      const result = await this.get<{
        transactions: Array<{ consensus_timestamp: string }>
      }>(`/api/v1/transactions?account.id=${address}&limit=1&order=desc`)

      if (result.transactions && result.transactions.length > 0) {
        lastTimestamp = result.transactions[0].consensus_timestamp
      }
    } catch {
      // Start from scratch
    }

    const poll = async () => {
      while (active) {
        try {
          let path = `/api/v1/transactions?account.id=${address}&limit=10&order=asc`
          if (lastTimestamp) {
            path += `&timestamp=gt:${lastTimestamp}`
          }

          const result = await this.get<{
            transactions: Array<{
              transaction_id: string
              consensus_timestamp: string
              charged_tx_fee: number
              result: string
              transfers: Array<{ account: string; amount: number }>
              nonce: number
            }>
          }>(path)

          if (result.transactions && result.transactions.length > 0) {
            for (const rawTx of result.transactions) {
              if (!active) break

              // Determine from/to from transfers
              // The sender has the largest negative transfer, the receiver has the largest positive one
              let from = ''
              let to: string | null = null
              let value = '0'
              let largestNegative = 0
              let largestPositive = 0

              for (const transfer of rawTx.transfers) {
                if (transfer.amount < largestNegative) {
                  largestNegative = transfer.amount
                  from = transfer.account
                }
                if (transfer.amount > largestPositive) {
                  largestPositive = transfer.amount
                  to = transfer.account
                  value = transfer.amount.toString()
                }
              }

              const timestampParts = rawTx.consensus_timestamp.split('.')
              const timestamp = parseInt(timestampParts[0], 10)

              const txInfo: TransactionInfo = {
                hash: rawTx.transaction_id,
                from,
                to,
                value,
                fee: rawTx.charged_tx_fee.toString(),
                blockNumber: null,
                blockHash: null,
                status: rawTx.result === 'SUCCESS' ? 'confirmed' : 'failed',
                timestamp,
                nonce: rawTx.nonce,
              }

              callback(txInfo)
            }

            lastTimestamp = result.transactions[result.transactions.length - 1].consensus_timestamp
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }
}
