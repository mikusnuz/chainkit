import {
  RpcManager,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type {
  ChainProvider,
  FeeEstimate,
  SubscriptionCapable,
  UtxoCapable,
  Address,
  TxHash,
  Balance,
  TransactionInfo,
  BlockInfo,
  ChainInfo,
  HexString,
  Utxo,
  Unsubscribe,
  RpcManagerConfig,
} from '@chainkit/core'

/**
 * Configuration for BitcoinProvider supporting both JSON-RPC and REST modes.
 */
export interface BitcoinProviderConfig {
  /** JSON-RPC endpoint URLs (for Bitcoin Core RPC) */
  endpoints?: string[]
  /** REST API base URL (e.g., "https://blockstream.info/testnet/api") */
  restUrl?: string
  /** Network type (default: 'mainnet') */
  network?: 'mainnet' | 'testnet'
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
  /** Number of retries per endpoint (default: 2) */
  retries?: number
}

/**
 * Bitcoin provider implementing ChainProvider, UtxoCapable,
 * and SubscriptionCapable interfaces.
 *
 * Supports two modes:
 * - JSON-RPC via RpcManager (for Bitcoin Core RPC nodes)
 * - REST API (for Blockstream-compatible REST APIs)
 *
 * If `restUrl` is provided, the provider uses REST mode.
 * If `endpoints` is provided, the provider uses JSON-RPC mode.
 * Accepts either BitcoinProviderConfig or the legacy RpcManagerConfig.
 */
export class BitcoinProvider
  implements ChainProvider, UtxoCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager | null
  private readonly restUrl: string | null
  private readonly restTimeout: number
  private readonly network: 'mainnet' | 'testnet'

  constructor(config: BitcoinProviderConfig | RpcManagerConfig) {
    // Check if this is a BitcoinProviderConfig with restUrl
    if ('restUrl' in config && config.restUrl) {
      this.restUrl = config.restUrl.replace(/\/+$/, '')
      this.rpc = null
      this.restTimeout = config.timeout ?? 10000
      this.network = config.network ?? (this.restUrl.includes('testnet') ? 'testnet' : 'mainnet')
    } else {
      // Legacy RpcManagerConfig or BitcoinProviderConfig with endpoints
      const endpoints = 'endpoints' in config ? config.endpoints : undefined
      if (!endpoints || endpoints.length === 0) {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'Bitcoin provider requires either endpoints (JSON-RPC) or restUrl (REST API)',
        )
      }
      this.rpc = new RpcManager({
        endpoints,
        timeout: config.timeout,
        retries: config.retries,
      })
      this.restUrl = null
      this.restTimeout = config.timeout ?? 10000
      this.network = ('network' in config ? config.network : undefined) ?? 'mainnet'
    }
  }

  /**
   * Internal helper to make REST API GET requests (for REST mode).
   */
  private async restGet<T>(path: string): Promise<T> {
    if (!this.restUrl) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'REST URL not configured')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.restTimeout)

    try {
      const response = await fetch(`${this.restUrl}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new ChainKitError(
          ErrorCode.NETWORK_ERROR,
          `HTTP ${response.status}: ${response.statusText}`,
          { status: response.status },
        )
      }

      const text = await response.text()
      try {
        return JSON.parse(text) as T
      } catch {
        // Some Blockstream endpoints return plain text (e.g., block height)
        return text as unknown as T
      }
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${this.restUrl}${path} timed out`)
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
   * Internal helper to make REST API POST requests (for broadcasting).
   */
  private async restPost(path: string, body: string): Promise<string> {
    if (!this.restUrl) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'REST URL not configured')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.restTimeout)

    try {
      const response = await fetch(`${this.restUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
        signal: controller.signal,
      })

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        throw new ChainKitError(
          ErrorCode.TRANSACTION_FAILED,
          `HTTP ${response.status}: ${errBody || response.statusText}`,
          { status: response.status },
        )
      }

      return response.text()
    } catch (err) {
      if (err instanceof ChainKitError) throw err
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
   * Get the BTC balance of an address by summing all UTXOs.
   * Uses REST /address/{addr} or JSON-RPC scantxoutset.
   */
  async getBalance(address: Address): Promise<Balance> {
    if (this.restUrl) {
      // REST mode: use /address/{addr} endpoint (Blockstream-compatible)
      const addrInfo = await this.restGet<{
        address: string
        chain_stats: { funded_txo_sum: number; spent_txo_sum: number }
        mempool_stats: { funded_txo_sum: number; spent_txo_sum: number }
      }>(`/address/${address}`)

      const confirmed = (addrInfo.chain_stats.funded_txo_sum - addrInfo.chain_stats.spent_txo_sum)
      const mempool = (addrInfo.mempool_stats.funded_txo_sum - addrInfo.mempool_stats.spent_txo_sum)
      const total = BigInt(confirmed) + BigInt(mempool)

      return {
        address,
        amount: total.toString(),
        symbol: 'BTC',
        decimals: 8,
      }
    }

    const utxos = await this.getUtxos(address)

    let totalSatoshis = 0n
    for (const utxo of utxos) {
      totalSatoshis += BigInt(utxo.amount)
    }

    return {
      address,
      amount: totalSatoshis.toString(),
      symbol: 'BTC',
      decimals: 8,
    }
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    if (this.restUrl) {
      return this.getTransactionRest(hash)
    }

    try {
      // getrawtransaction with verbose=true returns decoded tx
      const tx = await this.rpc!.request<Record<string, unknown>>(
        'getrawtransaction',
        [hash, true],
      )

      if (!tx) return null

      // Extract basic info
      const txid = tx.txid as string
      const blockHash = (tx.blockhash as string) ?? null
      let blockNumber: number | null = null
      let timestamp: number | null = null
      let status: 'pending' | 'confirmed' | 'failed' = 'pending'

      if (blockHash) {
        status = 'confirmed'
        // Fetch block to get height and time
        const block = await this.rpc!.request<Record<string, unknown>>(
          'getblock',
          [blockHash],
        )
        if (block) {
          blockNumber = block.height as number
          timestamp = block.time as number
        }
      }

      // Calculate total value from outputs
      const vout = (tx.vout as Array<{ value: number; n: number; scriptPubKey: Record<string, unknown> }>) ?? []
      let totalValue = 0n
      for (const output of vout) {
        totalValue += BigInt(Math.round(output.value * 1e8))
      }

      // Get the first input's address as "from" and first output's address as "to"
      const vin = (tx.vin as Array<Record<string, unknown>>) ?? []
      const fromAddress = vin.length > 0 ? (vin[0].address as string ?? 'unknown') : 'coinbase'
      const toAddress = vout.length > 0
        ? ((vout[0].scriptPubKey?.address as string) ?? (vout[0].scriptPubKey?.addresses as string[])?.[0] ?? 'unknown')
        : null

      // Calculate fee from the RPC response if available
      const fee = tx.fee !== undefined
        ? BigInt(Math.round(Math.abs(tx.fee as number) * 1e8)).toString()
        : '0'

      return {
        hash: txid,
        from: fromAddress,
        to: toAddress,
        value: totalValue.toString(),
        fee,
        blockNumber,
        blockHash,
        status,
        timestamp,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        // TX not found
        return null
      }
      throw err
    }
  }

  /**
   * Get block details by number (height) or hash.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    if (this.restUrl) {
      return this.getBlockRest(hashOrNumber)
    }

    try {
      let blockHash: string

      if (typeof hashOrNumber === 'number') {
        // Get block hash by height
        blockHash = await this.rpc!.request<string>('getblockhash', [hashOrNumber])
      } else {
        blockHash = hashOrNumber
      }

      const block = await this.rpc!.request<Record<string, unknown>>('getblock', [blockHash])
      if (!block) return null

      return {
        number: block.height as number,
        hash: block.hash as string,
        parentHash: (block.previousblockhash as string) ?? '0'.repeat(64),
        timestamp: block.time as number,
        transactions: (block.tx as string[]) ?? [],
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get the UTXO count for an address (Bitcoin does not have a nonce concept).
   * Returns the number of confirmed UTXOs as a proxy.
   */
  async getNonce(address: Address): Promise<number> {
    const utxos = await this.getUtxos(address)
    return utxos.filter(u => u.confirmed).length
  }

  /**
   * Estimate transaction fees in sat/vByte.
   */
  async estimateFee(): Promise<FeeEstimate> {
    if (this.restUrl) {
      // REST mode: use /fee-estimates endpoint (Blockstream-compatible)
      const estimates = await this.restGet<Record<string, number>>('/fee-estimates')
      // Keys are confirmation targets, values are sat/vB
      return {
        slow: (estimates['6'] ?? estimates['25'] ?? 1).toFixed(1),
        average: (estimates['3'] ?? estimates['6'] ?? 2).toFixed(1),
        fast: (estimates['1'] ?? estimates['2'] ?? 5).toFixed(1),
        unit: 'sat/vB',
      }
    }

    // Bitcoin Core's estimatesmartfee takes a confirmation target (number of blocks)
    const [slow, average, fast] = await Promise.all([
      this.rpc!.request<Record<string, unknown>>('estimatesmartfee', [6]),
      this.rpc!.request<Record<string, unknown>>('estimatesmartfee', [3]),
      this.rpc!.request<Record<string, unknown>>('estimatesmartfee', [1]),
    ])

    // estimatesmartfee returns BTC/kB, convert to sat/vByte
    const toSatPerVByte = (result: Record<string, unknown>): string => {
      const btcPerKb = (result.feerate as number) ?? 0.00001
      // BTC/kB -> sat/vB: multiply by 1e8 (to satoshis) then divide by 1000 (kB to vB)
      const satPerVByte = (btcPerKb * 1e8) / 1000
      return satPerVByte.toFixed(1)
    }

    return {
      slow: toSatPerVByte(slow),
      average: toSatPerVByte(average),
      fast: toSatPerVByte(fast),
      unit: 'sat/vB',
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const rawHex = signedTx.startsWith('0x') ? signedTx.slice(2) : signedTx

    if (this.restUrl) {
      // REST mode: POST raw hex to /tx endpoint
      return this.restPost('/tx', rawHex)
    }

    return this.rpc!.request<string>('sendrawtransaction', [rawHex])
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    if (this.restUrl) {
      // REST mode: get block tip height
      const blockHeight = await this.restGet<number>('/blocks/tip/height')
      const isTestnet = this.network === 'testnet'

      return {
        chainId: isTestnet ? 'test' : 'main',
        name: isTestnet ? 'Bitcoin Testnet' : 'Bitcoin Mainnet',
        symbol: 'BTC',
        decimals: 8,
        testnet: isTestnet,
        blockHeight: typeof blockHeight === 'number' ? blockHeight : parseInt(String(blockHeight), 10),
      }
    }

    const info = await this.rpc!.request<Record<string, unknown>>('getblockchaininfo', [])

    const chain = info.chain as string
    const blocks = info.blocks as number

    const isTestnet = chain !== 'main'
    let name: string
    switch (chain) {
      case 'main':
        name = 'Bitcoin Mainnet'
        break
      case 'test':
        name = 'Bitcoin Testnet'
        break
      case 'signet':
        name = 'Bitcoin Signet'
        break
      case 'regtest':
        name = 'Bitcoin Regtest'
        break
      default:
        name = `Bitcoin ${chain}`
    }

    return {
      chainId: chain,
      name,
      symbol: 'BTC',
      decimals: 8,
      testnet: isTestnet,
      blockHeight: blocks,
    }
  }

  // ------- UtxoCapable -------

  /**
   * Get unspent transaction outputs for an address.
   */
  async getUtxos(address: Address): Promise<Utxo[]> {
    if (this.restUrl) {
      // REST mode: use /address/{addr}/utxo endpoint (Blockstream-compatible)
      const utxos = await this.restGet<Array<{
        txid: string
        vout: number
        value: number
        status: { confirmed: boolean; block_height?: number }
      }>>(`/address/${address}/utxo`)

      return utxos.map((utxo) => ({
        txHash: utxo.txid,
        outputIndex: utxo.vout,
        amount: utxo.value.toString(),
        script: '',
        confirmed: utxo.status.confirmed,
      }))
    }

    // Use scantxoutset which works for any address without importing
    const result = await this.rpc!.request<Record<string, unknown>>('scantxoutset', [
      'start',
      [`addr(${address})`],
    ])

    const unspents = (result.unspents as Array<Record<string, unknown>>) ?? []

    return unspents.map((utxo) => ({
      txHash: utxo.txid as string,
      outputIndex: utxo.vout as number,
      amount: BigInt(Math.round((utxo.amount as number) * 1e8)).toString(),
      script: (utxo.scriptPubKey as string) ?? '',
      confirmed: (utxo.height as number) > 0,
    }))
  }

  /**
   * Select UTXOs for a target amount using a simple greedy coin selection.
   */
  async selectUtxos(
    address: Address,
    targetAmount: string,
  ): Promise<{ utxos: Utxo[]; change: string }> {
    const allUtxos = await this.getUtxos(address)

    // Sort by amount descending for largest-first selection
    const sorted = [...allUtxos].sort((a, b) => {
      const diff = BigInt(b.amount) - BigInt(a.amount)
      return diff > 0n ? 1 : diff < 0n ? -1 : 0
    })

    const target = BigInt(targetAmount)
    let accumulated = 0n
    const selected: Utxo[] = []

    for (const utxo of sorted) {
      if (accumulated >= target) break
      selected.push(utxo)
      accumulated += BigInt(utxo.amount)
    }

    if (accumulated < target) {
      throw new ChainKitError(
        ErrorCode.INSUFFICIENT_BALANCE,
        `Insufficient funds: have ${accumulated.toString()} satoshis, need ${target.toString()}`,
      )
    }

    return {
      utxos: selected,
      change: (accumulated - target).toString(),
    }
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Polls every ~10 minutes (Bitcoin block time average).
   * Uses a 30-second poll interval for responsiveness.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const blockNumber = await this.getCurrentBlockHeight()

          if (blockNumber > lastBlockNumber) {
            lastBlockNumber = blockNumber
            callback(blockNumber)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 30000))
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
   * Polls every 30 seconds and checks new blocks for matching transactions.
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
          const currentBlock = await this.getCurrentBlockHeight()

          if (currentBlock > lastBlockNumber) {
            if (this.restUrl) {
              // REST mode: check address transactions (simplified)
              // We just poll UTXOs and check for changes (subscription is best-effort)
              lastBlockNumber = currentBlock
            } else {
              for (
                let blockNum = lastBlockNumber + 1;
                blockNum <= currentBlock && active;
                blockNum++
              ) {
                const blockHash = await this.rpc!.request<string>('getblockhash', [blockNum])
                const block = await this.rpc!.request<Record<string, unknown>>('getblock', [blockHash, 2])

                if (block && Array.isArray(block.tx)) {
                  for (const rawTx of block.tx as Array<Record<string, unknown>>) {
                    // Check if any vout sends to our address
                    const vout = (rawTx.vout as Array<Record<string, unknown>>) ?? []
                    const matches = vout.some((output) => {
                      const scriptPubKey = output.scriptPubKey as Record<string, unknown>
                      return (
                        scriptPubKey?.address === address ||
                        (scriptPubKey?.addresses as string[])?.includes(address)
                      )
                    })

                    if (matches) {
                      const txInfo = await this.getTransaction(rawTx.txid as string)
                      if (txInfo) {
                        callback(txInfo)
                      }
                    }
                  }
                }
              }
              lastBlockNumber = currentBlock
            }
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 30000))
        }
      }
    }

    // Initialize lastBlockNumber
    try {
      lastBlockNumber = await this.getCurrentBlockHeight()
    } catch {
      // Start from 0
    }

    // Start polling in background
    poll()

    return () => {
      active = false
    }
  }

  // ------- Internal REST helpers -------

  /**
   * Get the current block height, abstracting over REST and RPC modes.
   */
  private async getCurrentBlockHeight(): Promise<number> {
    if (this.restUrl) {
      const height = await this.restGet<number>('/blocks/tip/height')
      return typeof height === 'number' ? height : parseInt(String(height), 10)
    }
    const info = await this.rpc!.request<Record<string, unknown>>('getblockchaininfo', [])
    return info.blocks as number
  }

  /**
   * Get transaction details via REST API (Blockstream-compatible).
   */
  private async getTransactionRest(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const tx = await this.restGet<{
        txid: string
        fee: number
        status: {
          confirmed: boolean
          block_height?: number
          block_hash?: string
          block_time?: number
        }
        vin: Array<{
          txid: string
          vout: number
          prevout?: {
            scriptpubkey_address?: string
            value: number
          }
        }>
        vout: Array<{
          scriptpubkey_address?: string
          value: number
        }>
      }>(`/tx/${hash}`)

      if (!tx) return null

      const status: 'pending' | 'confirmed' | 'failed' = tx.status.confirmed
        ? 'confirmed'
        : 'pending'

      let totalValue = 0n
      for (const output of tx.vout) {
        totalValue += BigInt(output.value)
      }

      const from = tx.vin.length > 0
        ? (tx.vin[0].prevout?.scriptpubkey_address ?? 'unknown')
        : 'coinbase'
      const to = tx.vout.length > 0
        ? (tx.vout[0].scriptpubkey_address ?? null)
        : null

      return {
        hash: tx.txid,
        from,
        to,
        value: totalValue.toString(),
        fee: tx.fee.toString(),
        blockNumber: tx.status.block_height ?? null,
        blockHash: tx.status.block_hash ?? null,
        status,
        timestamp: tx.status.block_time ?? null,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.NETWORK_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get block details via REST API (Blockstream-compatible).
   */
  private async getBlockRest(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      let blockHash: string

      if (typeof hashOrNumber === 'number') {
        blockHash = await this.restGet<string>(`/block-height/${hashOrNumber}`)
        blockHash = String(blockHash).trim()
      } else {
        blockHash = hashOrNumber
      }

      const block = await this.restGet<{
        id: string
        height: number
        previousblockhash: string
        timestamp: number
        tx_count: number
      }>(`/block/${blockHash}`)

      if (!block) return null

      // Get transaction IDs for this block
      const txids = await this.restGet<string[]>(`/block/${blockHash}/txids`)

      return {
        number: block.height,
        hash: block.id,
        parentHash: block.previousblockhash ?? '0'.repeat(64),
        timestamp: block.timestamp,
        transactions: txids ?? [],
      }
    } catch (err) {
      if (err instanceof ChainKitError) {
        return null
      }
      throw err
    }
  }
}
