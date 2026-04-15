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
 * Configuration for the Flow REST API provider.
 */
export interface FlowProviderConfig {
  /** Flow Access API REST base URL (e.g., "https://rest-testnet.onflow.org") */
  accessApiUrl: string
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
}

/**
 * Flow provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses the Flow Access API (REST) for all blockchain interactions.
 * REST endpoints:
 *   - GET /v1/accounts/{address} - Account info & balance
 *   - GET /v1/blocks - Block info
 *   - POST /v1/transactions - Submit transactions
 *   - GET /v1/transactions/{id} - Transaction details
 *   - POST /v1/scripts - Execute Cadence scripts
 */
export class FlowProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly accessApiUrl: string
  private readonly timeout: number

  constructor(config: FlowProviderConfig) {
    if (!config.accessApiUrl) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'Flow Access API URL is required')
    }
    // Remove trailing slash
    this.accessApiUrl = config.accessApiUrl.replace(/\/+$/, '')
    this.timeout = config.timeout ?? 10000
  }

  /**
   * Internal helper to make REST API GET requests.
   */
  private async restGet<T>(path: string): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.accessApiUrl}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok) {
        if (response.status === 404) {
          throw new ChainKitError(ErrorCode.RPC_ERROR, `Not found: ${path}`, {
            status: 404,
          })
        }
        throw new ChainKitError(
          ErrorCode.NETWORK_ERROR,
          `HTTP ${response.status}: ${response.statusText}`,
          { status: response.status },
        )
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${this.accessApiUrl}${path} timed out`)
      }
      throw new ChainKitError(
        ErrorCode.NETWORK_ERROR,
        `Request failed: ${(err as Error).message}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Internal helper to make REST API POST requests.
   */
  private async restPost<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.accessApiUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        throw new ChainKitError(
          ErrorCode.TRANSACTION_FAILED,
          `Request failed: HTTP ${response.status}`,
          { status: response.status, body: errorBody },
        )
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${this.accessApiUrl}${path} timed out`)
      }
      throw new ChainKitError(
        ErrorCode.NETWORK_ERROR,
        `Request failed: ${(err as Error).message}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  // ------- ChainProvider -------

  /**
   * Get the FLOW balance of an address.
   * Uses GET /v1/accounts/{address}
   *
   * Flow balance is stored in the account's default FLOW token vault.
   * The balance from the Access API is in 10^-8 FLOW (8 decimal places).
   */
  async getBalance(address: Address): Promise<Balance> {
    const cleanAddress = stripFlowPrefix(address)

    try {
      const account = await this.restGet<{
        address: string
        balance: string
        keys: Array<unknown>
      }>(`/v1/accounts/${cleanAddress}?block_height=sealed`)

      return {
        address,
        amount: account.balance,
        symbol: 'FLOW',
        decimals: 8,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return {
          address,
          amount: '0',
          symbol: 'FLOW',
          decimals: 8,
        }
      }
      throw err
    }
  }

  /**
   * Get transaction details by ID (hash).
   * Uses GET /v1/transactions/{id}
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const tx = await this.restGet<{
        id: string
        script: string
        arguments: string[]
        reference_block_id: string
        gas_limit: string
        payer: string
        proposal_key: {
          address: string
          key_index: string
          sequence_number: string
        }
        authorizers: string[]
        payload_signatures: Array<unknown>
        envelope_signatures: Array<unknown>
      }>(`/v1/transactions/${hash}`)

      // Also fetch the transaction result
      let status: 'pending' | 'confirmed' | 'failed' = 'pending'
      let blockNumber: number | null = null
      let blockHash: string | null = null

      try {
        const result = await this.restGet<{
          block_id: string
          block_height: string
          status: string
          status_code: number
          error_message: string
          events: Array<unknown>
        }>(`/v1/transaction_results/${hash}`)

        if (result.status === 'SEALED') {
          status = result.status_code === 0 ? 'confirmed' : 'failed'
          blockHash = result.block_id
          blockNumber = parseInt(result.block_height, 10) || null
        } else if (result.status === 'FINALIZED' || result.status === 'EXECUTED') {
          status = 'pending'
          blockHash = result.block_id
          blockNumber = parseInt(result.block_height, 10) || null
        }
      } catch {
        // Result not available yet
      }

      return {
        hash: tx.id,
        from: tx.payer,
        to: tx.authorizers.length > 0 ? tx.authorizers[0] : null,
        value: '0', // Flow transactions use Cadence scripts, not direct value transfers
        fee: tx.gas_limit,
        blockNumber,
        blockHash,
        status,
        timestamp: null, // Would require fetching the block
        nonce: parseInt(tx.proposal_key.sequence_number, 10) || 0,
        data: tx.script ? '0x' + Buffer.from(tx.script).toString('hex') : undefined,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get block details by height or ID.
   * Uses GET /v1/blocks
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      let blocks: Array<{
        header: {
          id: string
          parent_id: string
          height: string
          timestamp: string
        }
        payload: {
          collection_guarantees: Array<{ collection_id: string }>
        }
      }>

      if (typeof hashOrNumber === 'number') {
        blocks = await this.restGet<typeof blocks>(
          `/v1/blocks?height=${hashOrNumber}`,
        )
      } else if (hashOrNumber.length === 64 || (hashOrNumber.startsWith('0x') && hashOrNumber.length === 66)) {
        // Block ID (hash)
        const blockId = stripFlowPrefix(hashOrNumber)
        blocks = await this.restGet<typeof blocks>(
          `/v1/blocks/${blockId}`,
        )
        // Single block response may not be an array
        if (!Array.isArray(blocks)) {
          blocks = [blocks as unknown as (typeof blocks)[0]]
        }
      } else {
        // Try as height
        const height = parseInt(hashOrNumber, 10)
        if (isNaN(height)) {
          throw new ChainKitError(
            ErrorCode.INVALID_PARAMS,
            `Invalid block identifier: ${hashOrNumber}`,
          )
        }
        blocks = await this.restGet<typeof blocks>(
          `/v1/blocks?height=${height}`,
        )
      }

      if (!blocks || blocks.length === 0) return null

      const block = blocks[0]
      const timestamp = block.header.timestamp
        ? Math.floor(new Date(block.header.timestamp).getTime() / 1000)
        : 0

      // Collection guarantees reference collections, not individual tx hashes
      const txHashes = (block.payload?.collection_guarantees ?? []).map(
        (cg) => cg.collection_id,
      )

      return {
        number: parseInt(block.header.height, 10),
        hash: block.header.id,
        parentHash: block.header.parent_id,
        timestamp,
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
   * Estimate transaction fees on Flow.
   * Flow uses a fixed computation cost model.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Flow has a fixed fee structure based on computation used
    // Base fee is 0.00001 FLOW (1000 units at 8 decimals)
    // Most transactions cost between 0.00001 and 0.001 FLOW
    return {
      slow: '1000',
      average: '10000',
      fast: '100000',
      unit: 'units (10^-8 FLOW)',
    }
  }

  /**
   * Broadcast a signed transaction to the Flow network.
   * Uses POST /v1/transactions
   *
   * Expects the signedTx to be a JSON string containing the full
   * Flow transaction object with signatures.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    let txBody: unknown

    try {
      txBody = JSON.parse(signedTx)
    } catch {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'signedTx must be a JSON string containing the Flow transaction object',
      )
    }

    const result = await this.restPost<{
      id: string
    }>('/v1/transactions', txBody)

    return result.id
  }

  /**
   * Get Flow chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    try {
      // Fetch the latest sealed block to determine chain status
      const blocks = await this.restGet<
        Array<{
          header: {
            height: string
            id: string
          }
        }>
      >('/v1/blocks?height=sealed')

      const blockHeight = blocks.length > 0
        ? parseInt(blocks[0].header.height, 10)
        : 0

      // Determine network from URL
      const isTestnet = this.accessApiUrl.includes('testnet')
      const isMainnet = this.accessApiUrl.includes('mainnet')

      let name = 'Flow'
      let testnet = false

      if (isTestnet) {
        name = 'Flow Testnet'
        testnet = true
      } else if (isMainnet) {
        name = 'Flow Mainnet'
        testnet = false
      } else {
        name = 'Flow Network'
        testnet = true
      }

      return {
        chainId: 'flow',
        name,
        symbol: 'FLOW',
        decimals: 8,
        testnet,
        blockHeight,
      }
    } catch (err) {
      throw new ChainKitError(
        ErrorCode.NETWORK_ERROR,
        `Failed to get chain info: ${(err as Error).message}`,
      )
    }
  }

  // ------- ContractCapable (Cadence) -------

  /**
   * Execute a read-only Cadence script on the Flow network.
   * Uses POST /v1/scripts
   *
   * @param contractAddress - Not used directly in Flow (scripts are self-contained)
   * @param method - The Cadence script to execute (as a string)
   * @param params - Script arguments in JSON-Cadence format
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // Base64 encode the Cadence script
    const scriptBase64 = btoa(method)

    // Convert params to JSON-Cadence argument format
    const args = (params ?? []).map((p) => {
      if (typeof p === 'string') {
        return btoa(JSON.stringify({ type: 'String', value: p }))
      }
      if (typeof p === 'number') {
        return btoa(JSON.stringify({ type: 'Int', value: p.toString() }))
      }
      if (typeof p === 'object' && p !== null) {
        return btoa(JSON.stringify(p))
      }
      return btoa(JSON.stringify({ type: 'String', value: String(p) }))
    })

    const result = await this.restPost<string>('/v1/scripts', {
      script: scriptBase64,
      arguments: args,
    })

    // The result is a base64-encoded JSON-Cadence value
    try {
      if (typeof result === 'string') {
        const decoded = atob(result)
        return JSON.parse(decoded)
      }
      return result
    } catch {
      return result
    }
  }

  /**
   * Estimate gas for a Flow transaction.
   * Flow uses a computation limit model rather than gas.
   * Default computation limit is 9999 for most transactions.
   */
  async estimateGas(
    _contractAddress: Address,
    _method: string,
    _params?: unknown[],
  ): Promise<string> {
    // Flow default computation limit
    return '9999'
  }

  // ------- TokenCapable -------

  /**
   * Get the balance of a specific fungible token for a Flow address.
   * Executes a Cadence script to read the token vault balance.
   *
   * @param address - The Flow account address
   * @param tokenAddress - The token contract address (e.g., "A.0x1654653399040a61.FlowToken")
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    const cleanAddress = stripFlowPrefix(address)

    // Parse token address to extract contract info
    const parts = tokenAddress.split('.')
    const contractName = parts.length >= 3 ? parts[2] : tokenAddress

    // Execute a Cadence script to get the token balance
    const script = `
      import FungibleToken from 0xf233dcee88fe0abe
      import ${contractName} from ${parts.length >= 2 ? parts[1] : tokenAddress}

      access(all) fun main(address: Address): UFix64 {
        let account = getAccount(address)
        let vaultRef = account.capabilities.borrow<&{FungibleToken.Balance}>(
          ${contractName}.VaultPublicPath
        ) ?? panic("Could not borrow Balance reference")
        return vaultRef.balance
      }
    `.trim()

    try {
      const result = await this.callContract('', script, [
        { type: 'Address', value: '0x' + cleanAddress },
      ])

      const value = typeof result === 'object' && result !== null && 'value' in result
        ? String((result as Record<string, unknown>).value)
        : '0'

      // Convert decimal FLOW to smallest unit (10^-8)
      const amount = decimalToSmallestUnit(value)

      return {
        address,
        amount,
        symbol: contractName,
        decimals: 8,
      }
    } catch {
      return {
        address,
        amount: '0',
        symbol: contractName,
        decimals: 8,
      }
    }
  }

  /**
   * Get metadata for a Flow fungible token.
   *
   * @param tokenAddress - The token identifier (e.g., "A.0x1654653399040a61.FlowToken")
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const parts = tokenAddress.split('.')
    const contractName = parts.length >= 3 ? parts[2] : tokenAddress

    return {
      address: tokenAddress,
      name: contractName,
      symbol: contractName,
      decimals: 8,
    }
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Polls the latest sealed block every ~2.5 seconds (Flow block time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockHeight = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const blocks = await this.restGet<
            Array<{
              header: { height: string }
            }>
          >('/v1/blocks?height=sealed')

          if (blocks.length > 0) {
            const currentHeight = parseInt(blocks[0].header.height, 10)

            if (currentHeight > lastBlockHeight) {
              lastBlockHeight = currentHeight
              callback(currentHeight)
            }
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 2500))
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
   * Polls the account's transaction history for new entries.
   *
   * Note: Flow Access API does not provide a direct endpoint for per-address
   * transaction subscriptions. This implementation polls sealed blocks and
   * checks for transactions involving the address.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastBlockHeight = 0
    let active = true

    // Initialize with current block height
    try {
      const blocks = await this.restGet<
        Array<{
          header: { height: string }
        }>
      >('/v1/blocks?height=sealed')

      if (blocks.length > 0) {
        lastBlockHeight = parseInt(blocks[0].header.height, 10)
      }
    } catch {
      // Start from 0
    }

    const poll = async () => {
      while (active) {
        try {
          const blocks = await this.restGet<
            Array<{
              header: { height: string; id: string }
              payload: {
                collection_guarantees: Array<{ collection_id: string }>
              }
            }>
          >('/v1/blocks?height=sealed')

          if (blocks.length > 0) {
            const currentHeight = parseInt(blocks[0].header.height, 10)

            if (currentHeight > lastBlockHeight) {
              // Check recent blocks for transactions involving this address
              for (
                let h = lastBlockHeight + 1;
                h <= currentHeight && active;
                h++
              ) {
                try {
                  const blockData = await this.restGet<
                    Array<{
                      payload: {
                        collection_guarantees: Array<{ collection_id: string }>
                      }
                    }>
                  >(`/v1/blocks?height=${h}`)

                  if (blockData.length > 0) {
                    const collections = blockData[0].payload?.collection_guarantees ?? []
                    for (const cg of collections) {
                      try {
                        const collection = await this.restGet<{
                          transactions: Array<{ id: string }>
                        }>(`/v1/collections/${cg.collection_id}`)

                        for (const txRef of collection.transactions ?? []) {
                          try {
                            const txInfo = await this.getTransaction(txRef.id)
                            if (
                              txInfo &&
                              (normalizeFlowAddress(txInfo.from) === normalizeFlowAddress(address) ||
                                (txInfo.to && normalizeFlowAddress(txInfo.to) === normalizeFlowAddress(address)))
                            ) {
                              callback(txInfo)
                            }
                          } catch {
                            // Skip failed transaction lookups
                          }
                        }
                      } catch {
                        // Skip failed collection lookups
                      }
                    }
                  }
                } catch {
                  // Skip failed block lookups
                }
              }
              lastBlockHeight = currentHeight
            }
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 2500))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }
}

// ---- Utility functions ----

/**
 * Strip Flow 0x prefix from address.
 */
function stripFlowPrefix(address: string): string {
  return address.startsWith('0x') ? address.slice(2) : address
}

/**
 * Normalize a Flow address for comparison (lowercase, no 0x prefix).
 */
function normalizeFlowAddress(address: string): string {
  return stripFlowPrefix(address).toLowerCase()
}

/**
 * Convert a decimal string (e.g., "100.00000000") to smallest unit (10^-8).
 * 1 FLOW = 100,000,000 smallest units.
 */
function decimalToSmallestUnit(decimal: string): string {
  const parts = decimal.split('.')
  const whole = parts[0] || '0'
  const frac = (parts[1] || '').padEnd(8, '0').slice(0, 8)

  const amount = BigInt(whole) * BigInt(100_000_000) + BigInt(frac)
  return amount.toString()
}
