import {
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type {
  ChainProvider,
  FeeEstimate,
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
import { bech32 } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils'
import type {
  IotaOutputResponse,
  IotaOutputsResponse,
  IotaBlockResponse,
  IotaNodeInfoResponse,
} from './types.js'

/**
 * Configuration for the IOTA provider.
 */
export interface IotaProviderConfig {
  /** Base URL of the IOTA node REST API (e.g., "https://api.testnet.shimmer.network") */
  baseUrl: string
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
}

/**
 * IOTA provider implementing ChainProvider, TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses the IOTA REST API (Stardust/Chrysalis protocol):
 * - Core API: /api/core/v2/
 * - Indexer API: /api/indexer/v2/
 */
export class IotaProvider implements ChainProvider, TokenCapable, SubscriptionCapable {
  private readonly baseUrl: string
  private readonly timeout: number

  constructor(config: IotaProviderConfig) {
    if (!config.baseUrl) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'IOTA node base URL is required')
    }
    // Remove trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.timeout = config.timeout ?? 10000
  }

  /**
   * Send a GET request to the IOTA REST API.
   */
  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const url = `${this.baseUrl}${path}`
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new ChainKitError(ErrorCode.NETWORK_ERROR, `HTTP ${response.status}: ${response.statusText}`, {
          url,
          status: response.status,
          body,
        })
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request timed out`, {
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(ErrorCode.NETWORK_ERROR, `Request failed: ${(err as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Send a POST request to the IOTA REST API.
   */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const url = `${this.baseUrl}${path}`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const respBody = await response.text().catch(() => '')
        throw new ChainKitError(ErrorCode.NETWORK_ERROR, `HTTP ${response.status}: ${response.statusText}`, {
          url,
          status: response.status,
          body: respBody,
        })
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request timed out`, {
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(ErrorCode.NETWORK_ERROR, `Request failed: ${(err as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Convert a bech32 IOTA address to its hex representation (without type byte).
   * Returns the hex-encoded address hash (without 0x prefix).
   */
  private addressToHex(address: Address): string {
    try {
      const decoded = bech32.decodeToBytes(address)
      // decoded.bytes contains: [type_byte (0x00)] [32 bytes blake2b hash]
      // The API expects just the 32-byte hash as hex, prefixed with 0x
      const addressBytes = decoded.bytes
      if (addressBytes.length !== 33) {
        throw new Error(`Unexpected address length: ${addressBytes.length}`)
      }
      // Return the full 33-byte hex (type + hash) for API queries
      return bytesToHex(addressBytes)
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        `Invalid IOTA bech32 address: ${address}`,
      )
    }
  }

  // ------- ChainProvider -------

  /**
   * Get the IOTA balance of an address.
   * Queries all basic outputs owned by the address and sums their amounts.
   */
  async getBalance(address: Address): Promise<Balance> {
    // Query indexer for all basic outputs owned by this address
    const outputIds = await this.get<IotaOutputsResponse>(
      `/api/indexer/v2/outputs/basic?address=${encodeURIComponent(address)}`,
    )

    let totalAmount = BigInt(0)

    // Fetch each output to sum the amounts
    for (const outputId of outputIds.items) {
      try {
        const output = await this.get<IotaOutputResponse>(
          `/api/core/v2/outputs/${outputId}`,
        )
        if (!output.metadata.isSpent) {
          totalAmount += BigInt(output.output.amount)
        }
      } catch {
        // Skip outputs that fail to fetch
      }
    }

    return {
      address,
      amount: totalAmount.toString(),
      symbol: 'IOTA',
      decimals: 6,
    }
  }

  /**
   * Get transaction (block) details by block ID.
   * In IOTA, blocks contain transaction payloads.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const block = await this.get<IotaBlockResponse>(
        `/api/core/v2/blocks/${hash}`,
      )

      if (!block.payload || block.payload.type !== 6) {
        // Not a transaction payload
        return null
      }

      const essence = block.payload.essence
      if (!essence) return null

      // Calculate total value from outputs
      let totalValue = BigInt(0)
      for (const output of essence.outputs) {
        totalValue += BigInt(output.amount)
      }

      // Extract sender from first input's transaction
      const from = essence.inputs.length > 0
        ? essence.inputs[0].transactionId
        : ''

      // Extract recipient from first output
      const to = essence.outputs.length > 0 ? '' : null

      return {
        hash,
        from,
        to,
        value: totalValue.toString(),
        fee: '0', // IOTA is feeless (PoW-based in Chrysalis)
        blockNumber: null,
        blockHash: hash,
        status: 'confirmed',
        timestamp: null,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.NETWORK_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get block (milestone) details by milestone index.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      if (typeof hashOrNumber === 'number' || /^\d+$/.test(String(hashOrNumber))) {
        // Get milestone by index
        const milestoneIndex = typeof hashOrNumber === 'number' ? hashOrNumber : parseInt(hashOrNumber, 10)
        const milestone = await this.get<{
          index: number
          milestoneId: string
          timestamp: number
          previousMilestoneId?: string
        }>(`/api/core/v2/milestones/${milestoneIndex}`)

        return {
          number: milestone.index,
          hash: milestone.milestoneId,
          parentHash: milestone.previousMilestoneId ?? '',
          timestamp: milestone.timestamp,
          transactions: [],
        }
      } else {
        // Get block by ID
        const block = await this.get<IotaBlockResponse>(
          `/api/core/v2/blocks/${hashOrNumber}`,
        )

        return {
          number: 0,
          hash: hashOrNumber,
          parentHash: block.parents.length > 0 ? block.parents[0] : '',
          timestamp: 0,
          transactions: [],
        }
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.NETWORK_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get the nonce for an address.
   * IOTA uses a UTXO model and does not have sequential nonces.
   * Always returns 0.
   */
  async getNonce(_address: Address): Promise<number> {
    return 0
  }

  /**
   * Estimate transaction fees.
   * IOTA is feeless (uses Proof of Work), so fees are always 0.
   */
  async estimateFee(): Promise<FeeEstimate> {
    return {
      slow: '0',
      average: '0',
      fast: '0',
      unit: 'micro',
    }
  }

  /**
   * Broadcast a signed block (transaction) to the IOTA network.
   * Expects a JSON-serialized block as a hex string.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    // Parse the signed transaction (expected as JSON string, hex-encoded)
    let blockPayload: unknown
    try {
      const txStr = signedTx.startsWith('0x') ? signedTx.slice(2) : signedTx
      // Try parsing as direct JSON first
      blockPayload = JSON.parse(txStr)
    } catch {
      // If it's hex-encoded JSON, decode it
      try {
        const txHex = signedTx.startsWith('0x') ? signedTx.slice(2) : signedTx
        const bytes = new Uint8Array(txHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
        const jsonStr = new TextDecoder().decode(bytes)
        blockPayload = JSON.parse(jsonStr)
      } catch {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'Invalid signed transaction format. Expected JSON-serialized IOTA block.',
        )
      }
    }

    const result = await this.post<{ blockId: string }>(
      '/api/core/v2/blocks',
      blockPayload,
    )

    return result.blockId
  }

  /**
   * Get IOTA chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const info = await this.get<IotaNodeInfoResponse>('/api/core/v2/info')

    const isTestnet = info.protocol.networkName !== 'iota-mainnet'

    return {
      chainId: info.protocol.networkName,
      name: info.name,
      symbol: info.baseToken.tickerSymbol,
      decimals: info.baseToken.decimals,
      testnet: isTestnet,
      blockHeight: info.status.latestMilestone.index,
    }
  }

  // ------- TokenCapable -------

  /**
   * Get the balance of a native token for an address.
   * Queries outputs with the specified native token and sums amounts.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    // Query basic outputs for the address
    const outputIds = await this.get<IotaOutputsResponse>(
      `/api/indexer/v2/outputs/basic?address=${encodeURIComponent(address)}`,
    )

    let totalAmount = BigInt(0)

    for (const outputId of outputIds.items) {
      try {
        const output = await this.get<IotaOutputResponse & {
          output: {
            type: number
            amount: string
            nativeTokens?: Array<{ id: string; amount: string }>
            unlockConditions: unknown[]
          }
        }>(`/api/core/v2/outputs/${outputId}`)

        if (!output.metadata.isSpent && output.output.nativeTokens) {
          for (const token of output.output.nativeTokens) {
            if (token.id === tokenAddress) {
              totalAmount += BigInt(token.amount)
            }
          }
        }
      } catch {
        // Skip outputs that fail to fetch
      }
    }

    return {
      address,
      amount: totalAmount.toString(),
      symbol: '',
      decimals: 0,
    }
  }

  /**
   * Get metadata for a native token (foundry output).
   * IOTA native tokens are defined by foundry outputs.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    // In IOTA Stardust, native token metadata is stored in foundry outputs.
    // The token ID encodes the foundry ID. Query the foundry output.
    try {
      const foundry = await this.get<{
        output: {
          type: number
          amount: string
          tokenScheme: {
            type: number
            mintedTokens: string
            meltedTokens: string
            maximumSupply: string
          }
          immutableFeatures?: Array<{
            type: number
            data?: string
          }>
        }
      }>(`/api/indexer/v2/outputs/foundry/${tokenAddress}`)

      const tokenScheme = foundry.output.tokenScheme
      const circulatingSupply = (
        BigInt(tokenScheme.mintedTokens) - BigInt(tokenScheme.meltedTokens)
      ).toString()

      return {
        address: tokenAddress,
        name: '',
        symbol: '',
        decimals: 0,
        totalSupply: circulatingSupply,
      }
    } catch {
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        `Token (foundry) not found: ${tokenAddress}`,
      )
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
   * Subscribe to new milestones (IOTA's equivalent of blocks) via polling.
   * Polls the node info endpoint for the latest milestone index.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastMilestone = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const info = await this.get<IotaNodeInfoResponse>('/api/core/v2/info')
          const currentMilestone = info.status.latestMilestone.index

          if (currentMilestone > lastMilestone) {
            lastMilestone = currentMilestone
            callback(currentMilestone)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 5000))
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
   * Polls the indexer for new outputs owned by the address.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let knownOutputIds = new Set<string>()
    let active = true
    let initialized = false

    const poll = async () => {
      while (active) {
        try {
          const outputIds = await this.get<IotaOutputsResponse>(
            `/api/indexer/v2/outputs/basic?address=${encodeURIComponent(address)}`,
          )

          if (!initialized) {
            // First poll: just record existing outputs
            knownOutputIds = new Set(outputIds.items)
            initialized = true
          } else {
            // Check for new outputs
            for (const outputId of outputIds.items) {
              if (!knownOutputIds.has(outputId)) {
                knownOutputIds.add(outputId)

                try {
                  const output = await this.get<IotaOutputResponse>(
                    `/api/core/v2/outputs/${outputId}`,
                  )

                  const txInfo: TransactionInfo = {
                    hash: output.metadata.transactionId,
                    from: '',
                    to: address,
                    value: output.output.amount,
                    fee: '0',
                    blockNumber: output.metadata.milestoneIndexBooked,
                    blockHash: output.metadata.blockId,
                    status: 'confirmed',
                    timestamp: output.metadata.milestoneTimestampBooked,
                  }

                  callback(txInfo)
                } catch {
                  // Skip outputs that fail to fetch
                }
              }
            }
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 5000))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }
}
