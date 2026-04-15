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
  UtxoCapable,
  Address,
  TxHash,
  Balance,
  TransactionInfo,
  BlockInfo,
  ChainInfo,
  HexString,
  TokenMetadata,
  Utxo,
  Unsubscribe,
} from '@chainkit/core'

/**
 * Configuration for CardanoProvider.
 * Uses Blockfrost-style REST API.
 */
export interface CardanoProviderConfig {
  /** Blockfrost API base URL (e.g., "https://cardano-mainnet.blockfrost.io/api/v0") */
  baseUrl: string
  /** Blockfrost project ID (API key) */
  projectId: string
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
  /** Number of retries (default: 2) */
  retries?: number
}

/**
 * Cardano provider implementing ChainProvider, ContractCapable,
 * TokenCapable, SubscriptionCapable, and UtxoCapable interfaces.
 *
 * Uses Blockfrost REST API for all blockchain interactions.
 */
export class CardanoProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable, UtxoCapable
{
  private readonly baseUrl: string
  private readonly projectId: string
  private readonly timeout: number
  private readonly retries: number

  constructor(config: CardanoProviderConfig) {
    if (!config.baseUrl) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'Blockfrost base URL is required')
    }
    if (!config.projectId) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'Blockfrost project ID is required')
    }

    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.projectId = config.projectId
    this.timeout = config.timeout ?? 10000
    this.retries = config.retries ?? 2
  }

  /**
   * Make a REST API request to Blockfrost.
   */
  private async request<T>(
    path: string,
    options?: { method?: string; body?: Uint8Array },
  ): Promise<T> {
    const method = options?.method ?? 'GET'
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeout)

      try {
        const headers: Record<string, string> = {
          'project_id': this.projectId,
        }

        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        }

        if (options?.body) {
          headers['Content-Type'] = 'application/cbor'
          fetchOptions.body = options.body
        }

        const response = await fetch(`${this.baseUrl}${path}`, fetchOptions)

        if (response.status === 404) {
          return null as T
        }

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '')
          throw new ChainKitError(
            ErrorCode.RPC_ERROR,
            `Blockfrost API error ${response.status}: ${errorBody || response.statusText}`,
            { status: response.status, path },
          )
        }

        return (await response.json()) as T
      } catch (err) {
        if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
          throw err
        }
        if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
          lastError = new ChainKitError(
            ErrorCode.TIMEOUT,
            `Request to ${this.baseUrl}${path} timed out`,
            { timeout: this.timeout },
          )
        } else {
          lastError = err instanceof Error ? err : new Error(String(err))
        }
      } finally {
        clearTimeout(timer)
      }
    }

    throw lastError ?? new ChainKitError(ErrorCode.NETWORK_ERROR, 'Request failed')
  }

  // ------- ChainProvider -------

  /**
   * Get the ADA balance of an address.
   * Computes balance from the sum of all UTXOs.
   */
  async getBalance(address: Address): Promise<Balance> {
    const utxos = await this.getUtxos(address)

    let total = 0n
    for (const utxo of utxos) {
      total += BigInt(utxo.amount)
    }

    return {
      address,
      amount: total.toString(),
      symbol: 'ADA',
      decimals: 6,
    }
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    const tx = await this.request<Record<string, unknown> | null>(`/txs/${hash}`)
    if (!tx) return null

    // Get UTXO details for this transaction
    const utxos = await this.request<Record<string, unknown> | null>(`/txs/${hash}/utxos`)

    let from = ''
    let to: string | null = null
    let value = '0'

    if (utxos) {
      const inputs = utxos.inputs as Array<Record<string, unknown>> | undefined
      const outputs = utxos.outputs as Array<Record<string, unknown>> | undefined

      if (inputs && inputs.length > 0) {
        from = inputs[0].address as string
      }
      if (outputs && outputs.length > 0) {
        // First output that is not the sender is the recipient
        const recipient = outputs.find((o) => o.address !== from)
        to = (recipient?.address ?? outputs[0].address) as string

        // Calculate value from amounts
        if (recipient) {
          const amounts = recipient.amount as Array<{ unit: string; quantity: string }> | undefined
          const lovelace = amounts?.find((a) => a.unit === 'lovelace')
          value = lovelace?.quantity ?? '0'
        }
      }
    }

    const fees = tx.fees as string | undefined
    const blockHeight = tx.block_height as number | undefined
    const blockHash = tx.block as string | undefined
    const slot = tx.slot as number | undefined
    const validContract = tx.valid_contract as boolean | undefined

    let status: 'pending' | 'confirmed' | 'failed' = 'confirmed'
    if (validContract === false) {
      status = 'failed'
    }

    return {
      hash,
      from,
      to,
      value,
      fee: fees ?? '0',
      blockNumber: blockHeight ?? null,
      blockHash: blockHash ?? null,
      status,
      timestamp: slot ? Math.floor(slot + 1596491091) : null, // Shelley epoch start offset
      nonce: undefined,
    }
  }

  /**
   * Get block details by number (height) or hash.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    const block = await this.request<Record<string, unknown> | null>(
      `/blocks/${hashOrNumber}`,
    )
    if (!block) return null

    const height = block.height as number
    const hash = block.hash as string
    const previousBlock = block.previous_block as string | null
    const time = block.time as number
    const txCount = block.tx_count as number

    // Fetch transaction hashes if there are any
    let transactions: string[] = []
    if (txCount > 0) {
      const txs = await this.request<string[] | null>(`/blocks/${hashOrNumber}/txs`)
      transactions = txs ?? []
    }

    return {
      number: height,
      hash,
      parentHash: previousBlock ?? '',
      timestamp: time,
      transactions,
    }
  }

  /**
   * Get the nonce for an address.
   * Cardano uses a UTXO model and does not have sequential nonces.
   * Always returns 0.
   */
  async getNonce(_address: Address): Promise<number> {
    return 0
  }

  /**
   * Estimate transaction fees on Cardano.
   * Uses the latest epoch parameters to calculate fee estimates.
   *
   * Cardano fee formula: fee = a * txSize + b
   * where a = minFeeA (per-byte fee) and b = minFeeB (constant fee).
   */
  async estimateFee(): Promise<FeeEstimate> {
    try {
      const params = await this.request<Record<string, unknown>>('/epochs/latest/parameters')

      const minFeeA = Number(params.min_fee_a ?? 44)
      const minFeeB = Number(params.min_fee_b ?? 155381)

      // Estimate for different transaction sizes
      const smallTxSize = 200  // Simple transfer
      const mediumTxSize = 400 // Multi-output
      const largeTxSize = 800  // Complex transaction

      return {
        slow: (minFeeA * smallTxSize + minFeeB).toString(),
        average: (minFeeA * mediumTxSize + minFeeB).toString(),
        fast: (minFeeA * largeTxSize + minFeeB).toString(),
        unit: 'lovelace',
      }
    } catch {
      // Default fee estimates
      return {
        slow: '170000',
        average: '180000',
        fast: '200000',
        unit: 'lovelace',
      }
    }
  }

  /**
   * Broadcast a signed transaction to the Cardano network.
   * Expects CBOR-encoded signed transaction bytes.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    // Blockfrost expects raw CBOR bytes
    const txBytes = typeof signedTx === 'string' && signedTx.startsWith('0x')
      ? hexToUint8Array(signedTx.slice(2))
      : hexToUint8Array(signedTx)

    const result = await this.request<string>('/tx/submit', {
      method: 'POST',
      body: txBytes,
    })

    return result
  }

  /**
   * Get Cardano chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [genesis, latestBlock] = await Promise.all([
      this.request<Record<string, unknown>>('/genesis'),
      this.request<Record<string, unknown>>('/blocks/latest'),
    ])

    const networkMagic = genesis.network_magic as number
    const isMainnet = networkMagic === 764824073

    return {
      chainId: networkMagic.toString(),
      name: isMainnet ? 'Cardano Mainnet' : 'Cardano Testnet',
      symbol: 'ADA',
      decimals: 6,
      testnet: !isMainnet,
      blockHeight: (latestBlock.height as number) ?? undefined,
    }
  }

  // ------- UtxoCapable -------

  /**
   * Get unspent transaction outputs for an address.
   */
  async getUtxos(address: Address): Promise<Utxo[]> {
    const utxos = await this.request<
      Array<{
        tx_hash: string
        tx_index: number
        output_index: number
        amount: Array<{ unit: string; quantity: string }>
        block: string
      }> | null
    >(`/addresses/${address}/utxos`)

    if (!utxos) return []

    return utxos.map((utxo) => {
      const lovelace = utxo.amount.find((a) => a.unit === 'lovelace')
      return {
        txHash: utxo.tx_hash,
        outputIndex: utxo.output_index ?? utxo.tx_index,
        amount: lovelace?.quantity ?? '0',
        script: '',
        confirmed: true,
      }
    })
  }

  /**
   * Select UTXOs for a target amount using a simple greedy algorithm.
   * Selects UTXOs in descending order of value until the target is reached.
   */
  async selectUtxos(
    address: Address,
    targetAmount: string,
  ): Promise<{ utxos: Utxo[]; change: string }> {
    const allUtxos = await this.getUtxos(address)
    const target = BigInt(targetAmount)

    // Sort by amount descending (largest first)
    const sorted = [...allUtxos].sort(
      (a, b) => Number(BigInt(b.amount) - BigInt(a.amount)),
    )

    const selected: Utxo[] = []
    let total = 0n

    for (const utxo of sorted) {
      selected.push(utxo)
      total += BigInt(utxo.amount)
      if (total >= target) {
        break
      }
    }

    if (total < target) {
      throw new ChainKitError(
        ErrorCode.INSUFFICIENT_BALANCE,
        `Insufficient UTXOs: need ${targetAmount} lovelace but only ${total.toString()} available`,
      )
    }

    return {
      utxos: selected,
      change: (total - target).toString(),
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only Plutus script or query script datum.
   * For Cardano, this queries the script's datum or redeemer.
   * @param contractAddress - The script address
   * @param method - The query type ("datum" or "redeemer")
   * @param params - Optional parameters (datum hash, etc.)
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    if (method === 'datum') {
      const datumHash = params?.[0] as string
      if (!datumHash) {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'Datum hash is required for Cardano script queries',
        )
      }
      return this.request(`/scripts/datum/${datumHash}`)
    }

    // Default: query script info
    return this.request(`/scripts/${contractAddress}`)
  }

  /**
   * Estimate execution units (CPU + memory) for a Plutus script.
   * Returns estimated fee as a string.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    // For Cardano, return estimated script execution fee
    // This is a simplified estimate; real implementation would use Ogmios or cardano-cli
    try {
      const epochParams = await this.request<Record<string, unknown>>(
        '/epochs/latest/parameters',
      )
      const priceStep = Number(epochParams.price_step ?? 0.0000721)
      const priceMem = Number(epochParams.price_mem ?? 0.0577)

      // Default execution units for a medium-complexity script
      const defaultCpuUnits = 200000000
      const defaultMemUnits = 700000

      const fee = Math.ceil(priceStep * defaultCpuUnits + priceMem * defaultMemUnits)
      return fee.toString()
    } catch {
      return '500000' // Default 0.5 ADA script execution fee
    }
  }

  // ------- TokenCapable -------

  /**
   * Get the balance of a specific native token for an address.
   * @param address - The holder address
   * @param tokenAddress - The token policy ID + asset name (hex)
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    const utxos = await this.request<
      Array<{
        amount: Array<{ unit: string; quantity: string }>
      }> | null
    >(`/addresses/${address}/utxos/${tokenAddress}`)

    if (!utxos || utxos.length === 0) {
      return {
        address,
        amount: '0',
        symbol: '',
        decimals: 0,
      }
    }

    let total = 0n
    for (const utxo of utxos) {
      const token = utxo.amount.find((a) => a.unit === tokenAddress)
      if (token) {
        total += BigInt(token.quantity)
      }
    }

    return {
      address,
      amount: total.toString(),
      symbol: '',
      decimals: 0,
    }
  }

  /**
   * Get metadata for a native token.
   * @param tokenAddress - The token policy ID + asset name (hex)
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const asset = await this.request<Record<string, unknown> | null>(
      `/assets/${tokenAddress}`,
    )

    if (!asset) {
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        `Asset not found: ${tokenAddress}`,
      )
    }

    const metadata = asset.onchain_metadata as Record<string, unknown> | null
    const assetName = asset.asset_name as string | null

    return {
      address: tokenAddress,
      name: (metadata?.name as string) ?? assetName ?? '',
      symbol: (metadata?.ticker as string) ?? '',
      decimals: (asset.metadata as Record<string, unknown>)?.decimals as number ?? 0,
      totalSupply: asset.quantity as string | undefined,
    }
  }

  /**
   * Get balances for multiple native tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Polls every ~20 seconds (Cardano average block time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastHeight = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const block = await this.request<Record<string, unknown>>('/blocks/latest')
          const height = block.height as number

          if (height > lastHeight) {
            lastHeight = height
            callback(height)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 20000))
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
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastTxHash: string | null = null
    let active = true

    // Get the most recent transaction to start from
    try {
      const txs = await this.request<Array<{ tx_hash: string }> | null>(
        `/addresses/${address}/transactions?count=1&order=desc`,
      )
      if (txs && txs.length > 0) {
        lastTxHash = txs[0].tx_hash
      }
    } catch {
      // Start from scratch
    }

    const poll = async () => {
      while (active) {
        try {
          let path = `/addresses/${address}/transactions?count=10&order=desc`
          const txs = await this.request<Array<{ tx_hash: string }> | null>(path)

          if (txs && txs.length > 0) {
            // Find new transactions
            const newTxs: string[] = []
            for (const tx of txs) {
              if (tx.tx_hash === lastTxHash) break
              newTxs.push(tx.tx_hash)
            }

            // Process in chronological order (oldest first)
            for (let i = newTxs.length - 1; i >= 0 && active; i--) {
              const txInfo = await this.getTransaction(newTxs[i])
              if (txInfo) {
                callback(txInfo)
              }
            }

            if (newTxs.length > 0) {
              lastTxHash = txs[0].tx_hash
            }
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 20000))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }
}

/**
 * Convert a hex string to Uint8Array.
 */
function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}
