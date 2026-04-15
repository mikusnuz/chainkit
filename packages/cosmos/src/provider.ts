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
import type { CosmosFeeDetail } from './types.js'

/**
 * Configuration for the Cosmos provider.
 */
export interface CosmosProviderConfig {
  /** LCD REST API endpoint URL (e.g., "https://lcd.cosmos.network") */
  lcdEndpoint: string
  /** Tendermint RPC endpoint URL (e.g., "https://rpc.cosmos.network") */
  rpcEndpoint?: string
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
}

/**
 * Cosmos provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses Cosmos LCD REST API and Tendermint RPC to interact with Cosmos SDK chains.
 */
export class CosmosProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly lcdEndpoint: string
  private readonly rpcEndpoint: string | null
  private readonly timeout: number

  constructor(config: CosmosProviderConfig) {
    if (!config.lcdEndpoint) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'LCD endpoint is required')
    }
    this.lcdEndpoint = config.lcdEndpoint.replace(/\/+$/, '')
    this.rpcEndpoint = config.rpcEndpoint?.replace(/\/+$/, '') ?? null
    this.timeout = config.timeout ?? 10000
  }

  /**
   * Make an HTTP GET request to the LCD endpoint.
   */
  private async lcdGet<T>(path: string): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.lcdEndpoint}${path}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new ChainKitError(
          ErrorCode.NETWORK_ERROR,
          `HTTP ${response.status}: ${response.statusText}`,
          { endpoint: this.lcdEndpoint, status: response.status },
        )
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to LCD timed out`, {
          endpoint: this.lcdEndpoint,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(
        ErrorCode.NETWORK_ERROR,
        `LCD request failed: ${(err as Error).message}`,
        { endpoint: this.lcdEndpoint },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Make an HTTP POST request to the LCD endpoint.
   */
  private async lcdPost<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.lcdEndpoint}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new ChainKitError(
          ErrorCode.NETWORK_ERROR,
          `HTTP ${response.status}: ${response.statusText}`,
          { endpoint: this.lcdEndpoint, status: response.status },
        )
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to LCD timed out`, {
          endpoint: this.lcdEndpoint,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(
        ErrorCode.NETWORK_ERROR,
        `LCD request failed: ${(err as Error).message}`,
        { endpoint: this.lcdEndpoint },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  // ------- ChainProvider -------

  /**
   * Get the ATOM balance of an address.
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.lcdGet<{
      balances: Array<{ denom: string; amount: string }>
    }>(`/cosmos/bank/v1beta1/balances/${address}`)

    // Find the uatom balance (native staking denom)
    const atomBalance = result.balances?.find((b) => b.denom === 'uatom')
    const amount = atomBalance?.amount ?? '0'

    return {
      address,
      amount,
      symbol: 'ATOM',
      decimals: 6,
    }
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const result = await this.lcdGet<{
        tx_response: {
          txhash: string
          height: string
          code: number
          timestamp: string
          gas_wanted: string
          gas_used: string
          tx: {
            body: {
              messages: Array<{
                '@type': string
                from_address?: string
                to_address?: string
                amount?: Array<{ denom: string; amount: string }>
              }>
              memo: string
            }
            auth_info: {
              fee: {
                amount: Array<{ denom: string; amount: string }>
              }
            }
          }
        }
      }>(`/cosmos/tx/v1beta1/txs/${hash}`)

      const txResponse = result.tx_response
      if (!txResponse) return null

      const messages = txResponse.tx?.body?.messages ?? []
      const firstMsg = messages[0]

      // Determine from/to from the first message (if it's a bank send)
      const from = firstMsg?.from_address ?? ''
      const to = firstMsg?.to_address ?? null
      const amounts = firstMsg?.amount ?? []
      const value = amounts.length > 0 ? amounts[0].amount : '0'

      // Calculate fee
      const feeAmounts = txResponse.tx?.auth_info?.fee?.amount ?? []
      const fee = feeAmounts.length > 0 ? feeAmounts[0].amount : '0'

      // Determine status
      const status: 'pending' | 'confirmed' | 'failed' =
        txResponse.code === 0 ? 'confirmed' : 'failed'

      const blockNumber = parseInt(txResponse.height, 10)
      const timestamp = txResponse.timestamp
        ? Math.floor(new Date(txResponse.timestamp).getTime() / 1000)
        : null

      return {
        hash: txResponse.txhash,
        from,
        to,
        value,
        fee,
        blockNumber: isNaN(blockNumber) ? null : blockNumber,
        blockHash: null,
        status,
        timestamp,
      }
    } catch (err) {
      if (
        err instanceof ChainKitError &&
        err.code === ErrorCode.NETWORK_ERROR
      ) {
        return null
      }
      throw err
    }
  }

  /**
   * Get block details by number or hash.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      const height = typeof hashOrNumber === 'number' ? hashOrNumber.toString() : hashOrNumber

      const result = await this.lcdGet<{
        block: {
          header: {
            height: string
            time: string
          }
          data: {
            txs: string[]
          }
        }
        block_id: {
          hash: string
        }
      }>(`/cosmos/base/tendermint/v1beta1/blocks/${height}`)

      if (!result.block) return null

      const header = result.block.header
      const blockNumber = parseInt(header.height, 10)
      const timestamp = Math.floor(new Date(header.time).getTime() / 1000)

      return {
        number: blockNumber,
        hash: result.block_id?.hash ?? '',
        parentHash: '',
        timestamp,
        transactions: result.block.data?.txs ?? [],
      }
    } catch {
      return null
    }
  }

  /**
   * Estimate transaction fees.
   * Returns a simple gas price estimate for the Cosmos chain.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Cosmos SDK doesn't have a standardized gas price API like EIP-1559
    // Use typical mainnet gas prices for ATOM
    return {
      slow: '0.01',
      average: '0.025',
      fast: '0.04',
      unit: 'uatom',
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const result = await this.lcdPost<{
      tx_response: {
        txhash: string
        code: number
        raw_log?: string
      }
    }>('/cosmos/tx/v1beta1/txs', {
      tx_bytes: signedTx,
      mode: 'BROADCAST_MODE_SYNC',
    })

    if (result.tx_response?.code !== 0) {
      throw new ChainKitError(
        ErrorCode.RPC_ERROR,
        `Broadcast failed: ${result.tx_response?.raw_log ?? 'unknown error'}`,
        { code: result.tx_response?.code },
      )
    }

    return result.tx_response.txhash
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const result = await this.lcdGet<{
      default_node_info: {
        network: string
      }
      application_version: {
        name: string
        version: string
      }
    }>('/cosmos/base/tendermint/v1beta1/node_info')

    // Get latest block for height
    let blockHeight: number | undefined
    try {
      const latestBlock = await this.lcdGet<{
        block: {
          header: {
            height: string
          }
        }
      }>('/cosmos/base/tendermint/v1beta1/blocks/latest')
      blockHeight = parseInt(latestBlock.block?.header?.height ?? '0', 10)
    } catch {
      // Ignore block height errors
    }

    const network = result.default_node_info?.network ?? 'cosmoshub-4'
    const isTestnet = network.includes('test') || network.includes('devnet')

    return {
      chainId: network,
      name: result.application_version?.name ?? 'Cosmos Hub',
      symbol: 'ATOM',
      decimals: 6,
      testnet: isTestnet,
      blockHeight,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only CosmWasm contract method.
   * The method parameter should be a base64-encoded query message or JSON string.
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // For CosmWasm, method is a JSON query message
    const queryMsg = method.startsWith('{') ? method : JSON.stringify({ [method]: params?.[0] ?? {} })
    const queryBase64 = btoa(queryMsg)

    const result = await this.lcdGet<{ data: string }>(
      `/cosmwasm/wasm/v1/contract/${contractAddress}/smart/${queryBase64}`,
    )

    return result.data
  }

  /**
   * Estimate gas for a contract call.
   * Cosmos SDK uses simulation for gas estimation.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    // Return a default gas estimate for CosmWasm execution
    // Actual estimation requires full tx simulation
    return '200000'
  }

  // ------- TokenCapable -------

  /**
   * Get the balance of a specific token for an address.
   * For Cosmos, tokenAddress is the token denom.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    const result = await this.lcdGet<{
      balance: { denom: string; amount: string }
    }>(`/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${tokenAddress}`)

    return {
      address,
      amount: result.balance?.amount ?? '0',
      symbol: tokenAddress,
      decimals: 6,
    }
  }

  /**
   * Get metadata for a token.
   * For Cosmos, tokenAddress is the token denom.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    try {
      const result = await this.lcdGet<{
        metadata: {
          name: string
          symbol: string
          description: string
          denom_units: Array<{ denom: string; exponent: number }>
          base: string
          display: string
        }
      }>(`/cosmos/bank/v1beta1/denoms_metadata/${tokenAddress}`)

      const metadata = result.metadata
      const displayUnit = metadata?.denom_units?.find(
        (u) => u.denom === metadata.display,
      )

      return {
        address: tokenAddress,
        name: metadata?.name ?? tokenAddress,
        symbol: metadata?.symbol ?? tokenAddress,
        decimals: displayUnit?.exponent ?? 6,
      }
    } catch {
      // Fallback for tokens without metadata
      return {
        address: tokenAddress,
        name: tokenAddress,
        symbol: tokenAddress,
        decimals: 6,
      }
    }
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Polls every ~6 seconds (Cosmos block time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const result = await this.lcdGet<{
            block: { header: { height: string } }
          }>('/cosmos/base/tendermint/v1beta1/blocks/latest')

          const blockNumber = parseInt(result.block?.header?.height ?? '0', 10)

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

    // Start polling in background
    poll()

    return () => {
      active = false
    }
  }

  /**
   * Subscribe to transactions for an address via polling.
   * Polls every ~6 seconds and checks for new transactions.
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
          const result = await this.lcdGet<{
            block: { header: { height: string } }
          }>('/cosmos/base/tendermint/v1beta1/blocks/latest')

          const currentBlock = parseInt(result.block?.header?.height ?? '0', 10)

          if (currentBlock > lastBlockNumber && lastBlockNumber > 0) {
            // Search for transactions involving the address in recent blocks
            try {
              const txResult = await this.lcdGet<{
                tx_responses: Array<{
                  txhash: string
                  height: string
                  code: number
                  timestamp: string
                  tx: {
                    body: {
                      messages: Array<{
                        from_address?: string
                        to_address?: string
                        amount?: Array<{ denom: string; amount: string }>
                      }>
                    }
                    auth_info: {
                      fee: { amount: Array<{ denom: string; amount: string }> }
                    }
                  }
                }>
              }>(
                `/cosmos/tx/v1beta1/txs?events=message.sender='${address}'&order_by=ORDER_BY_DESC&pagination.limit=5`,
              )

              for (const txResp of txResult.tx_responses ?? []) {
                const height = parseInt(txResp.height, 10)
                if (height > lastBlockNumber && height <= currentBlock) {
                  const firstMsg = txResp.tx?.body?.messages?.[0]
                  const feeAmounts = txResp.tx?.auth_info?.fee?.amount ?? []
                  const amounts = firstMsg?.amount ?? []

                  callback({
                    hash: txResp.txhash,
                    from: firstMsg?.from_address ?? '',
                    to: firstMsg?.to_address ?? null,
                    value: amounts.length > 0 ? amounts[0].amount : '0',
                    fee: feeAmounts.length > 0 ? feeAmounts[0].amount : '0',
                    blockNumber: height,
                    blockHash: null,
                    status: txResp.code === 0 ? 'confirmed' : 'failed',
                    timestamp: txResp.timestamp
                      ? Math.floor(new Date(txResp.timestamp).getTime() / 1000)
                      : null,
                  })
                }
              }
            } catch {
              // Ignore tx search errors
            }
          }

          lastBlockNumber = currentBlock
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 6000))
        }
      }
    }

    // Initialize lastBlockNumber
    try {
      const result = await this.lcdGet<{
        block: { header: { height: string } }
      }>('/cosmos/base/tendermint/v1beta1/blocks/latest')
      lastBlockNumber = parseInt(result.block?.header?.height ?? '0', 10)
    } catch {
      // Start from 0
    }

    // Start polling in background
    poll()

    return () => {
      active = false
    }
  }
}
