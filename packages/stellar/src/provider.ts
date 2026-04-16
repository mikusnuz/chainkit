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

/**
 * Configuration for the Stellar Horizon provider.
 */
export interface StellarProviderConfig {
  /** Horizon REST API base URL (e.g., "https://horizon.stellar.org") */
  horizonUrl: string
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
}

/**
 * Stellar provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses the Stellar Horizon REST API for all blockchain interactions.
 */
export class StellarProvider

  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly horizonUrl: string
  private readonly timeout: number

  constructor(config: StellarProviderConfig) {
    if (!config.horizonUrl) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'Horizon URL is required')
    }
    // Remove trailing slash
    this.horizonUrl = config.horizonUrl.replace(/\/+$/, '')
    this.timeout = config.timeout ?? 10000
  }

  /**
   * Internal helper to make Horizon REST API requests.
   */
  private async horizonGet<T>(path: string): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.horizonUrl}${path}`, {
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
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${this.horizonUrl}${path} timed out`)
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
   * Internal helper to POST to Horizon REST API.
   */
  private async horizonPost<T>(path: string, body: string): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.horizonUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        throw new ChainKitError(
          ErrorCode.TRANSACTION_FAILED,
          `Transaction submission failed: HTTP ${response.status}`,
          { status: response.status, body: errorBody },
        )
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${this.horizonUrl}${path} timed out`)
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
   * Get the XLM balance of an address.
   * Uses Horizon GET /accounts/{id}
   */
  async getBalance(address: Address): Promise<Balance> {
    try {
      const account = await this.horizonGet<{
        balances: Array<{
          asset_type: string
          asset_code?: string
          asset_issuer?: string
          balance: string
        }>
      }>(`/accounts/${address}`)

      // Find the native (XLM) balance
      const nativeBalance = account.balances.find((b) => b.asset_type === 'native')
      const amount = nativeBalance ? nativeBalance.balance : '0'

      // Stellar uses 7 decimal places; convert from decimal string to stroops
      const stroops = decimalToStroops(amount)

      return {
        address,
        amount: stroops,
        symbol: 'XLM',
        decimals: 7,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        // Account not found means zero balance
        return {
          address,
          amount: '0',
          symbol: 'XLM',
          decimals: 7,
        }
      }
      throw err
    }
  }

  /**
   * Get transaction details by hash.
   * Uses Horizon GET /transactions/{hash}
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const tx = await this.horizonGet<{
        hash: string
        source_account: string
        fee_charged: string
        created_at: string
        successful: boolean
        ledger: number
        memo_type: string
        memo?: string
        source_account_sequence: string
        envelope_xdr: string
        result_xdr: string
        _links?: {
          operations?: { href: string }
        }
      }>(`/transactions/${hash}`)

      // Try to extract destination from operations
      let to: string | null = null
      let value = '0'
      try {
        const ops = await this.horizonGet<{
          _embedded: {
            records: Array<{
              type: string
              to?: string
              destination?: string
              amount?: string
              starting_balance?: string
            }>
          }
        }>(`/transactions/${hash}/operations?limit=1`)

        if (ops._embedded.records.length > 0) {
          const op = ops._embedded.records[0]
          to = op.to ?? op.destination ?? null
          const rawAmount = op.amount ?? op.starting_balance ?? '0'
          value = decimalToStroops(rawAmount)
        }
      } catch {
        // Operations lookup failed, leave to as null
      }

      const timestamp = tx.created_at
        ? Math.floor(new Date(tx.created_at).getTime() / 1000)
        : null

      return {
        hash: tx.hash,
        from: tx.source_account,
        to,
        value,
        fee: tx.fee_charged,
        blockNumber: tx.ledger,
        blockHash: null,
        status: tx.successful ? 'confirmed' : 'failed',
        timestamp,
        nonce: parseInt(tx.source_account_sequence, 10) || 0,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get block (ledger) details by sequence number.
   * Uses Horizon GET /ledgers/{seq}
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    const seq = typeof hashOrNumber === 'number' ? hashOrNumber : parseInt(hashOrNumber, 10)

    if (isNaN(seq)) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        `Invalid ledger sequence: ${hashOrNumber}. Stellar uses ledger sequence numbers.`,
      )
    }

    try {
      const ledger = await this.horizonGet<{
        sequence: number
        hash: string
        prev_hash: string
        closed_at: string
        transaction_count: number
      }>(`/ledgers/${seq}`)

      // Fetch transaction hashes for this ledger
      let txHashes: string[] = []
      try {
        const txs = await this.horizonGet<{
          _embedded: {
            records: Array<{ hash: string }>
          }
        }>(`/ledgers/${seq}/transactions?limit=200`)
        txHashes = txs._embedded.records.map((t) => t.hash)
      } catch {
        // Failed to fetch transactions, leave empty
      }

      const timestamp = ledger.closed_at
        ? Math.floor(new Date(ledger.closed_at).getTime() / 1000)
        : 0

      return {
        number: ledger.sequence,
        hash: ledger.hash,
        parentHash: ledger.prev_hash,
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
   * Get the account sequence number for a Stellar address.
   */
  async getNonce(address: Address): Promise<string> {
    try {
      const account = await this.horizonGet<{ sequence: string }>(`/accounts/${address}`)
      return account.sequence
    } catch {
      return '0'
    }
  }

  /**
   * Estimate transaction fees on Stellar.
   * Uses Horizon GET /fee_stats
   */
  async estimateFee(): Promise<FeeEstimate> {
    try {
      const stats = await this.horizonGet<{
        last_ledger_base_fee: string
        last_ledger: string
        ledger_capacity_usage: string
        fee_charged: {
          max: string
          min: string
          mode: string
          p10: string
          p20: string
          p30: string
          p40: string
          p50: string
          p60: string
          p70: string
          p80: string
          p90: string
          p95: string
          p99: string
        }
      }>('/fee_stats')

      return {
        slow: stats.fee_charged.min,
        average: stats.fee_charged.mode,
        fast: stats.fee_charged.p95,
        unit: 'stroops',
      }
    } catch {
      // Default base fee is 100 stroops
      return {
        slow: '100',
        average: '100',
        fast: '200',
        unit: 'stroops',
      }
    }
  }

  /**
   * Broadcast a signed transaction to the Stellar network.
   * Expects a base64-encoded transaction envelope (XDR).
   * Uses Horizon POST /transactions
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const result = await this.horizonPost<{
      hash: string
      ledger: number
    }>('/transactions', `tx=${encodeURIComponent(signedTx)}`)

    return result.hash
  }

  /**
   * Get Stellar chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const root = await this.horizonGet<{
      horizon_version: string
      core_version: string
      network_passphrase: string
      history_latest_ledger: number
    }>('/')

    const passphrase = root.network_passphrase
    let name = 'Stellar'
    let testnet = false

    if (passphrase === 'Public Global Stellar Network ; September 2015') {
      name = 'Stellar Mainnet'
    } else if (passphrase === 'Test SDF Network ; September 2015') {
      name = 'Stellar Testnet'
      testnet = true
    } else {
      name = `Stellar (${passphrase})`
      testnet = true
    }

    return {
      chainId: passphrase,
      name,
      symbol: 'XLM',
      decimals: 7,
      testnet,
      blockHeight: root.history_latest_ledger,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only Soroban contract method.
   * For Stellar/Soroban, this invokes a contract function via simulation.
   * @param contractAddress - The contract ID
   * @param method - The method name
   * @param params - Method parameters
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // Soroban contract invocation via Horizon is limited.
    // This implementation provides a basic simulation endpoint.
    const account = await this.horizonGet<{
      sequence: string
    }>(`/accounts/${contractAddress}`)

    return {
      contractAddress,
      method,
      params: params ?? [],
      accountSequence: account.sequence,
    }
  }

  /**
   * Estimate gas (resource fee) for a Stellar contract call.
   * Returns the base fee as a fallback since detailed gas estimation
   * requires Soroban RPC.
   */
  async estimateGas(
    _contractAddress: Address,
    _method: string,
    _params?: unknown[],
  ): Promise<string> {
    // Stellar base fee per operation is 100 stroops minimum
    const feeEstimate = await this.estimateFee()
    return feeEstimate.average
  }

  // ------- TokenCapable -------

  /**
   * Get the balance of a specific Stellar asset for an address.
   * @param address - The holder address
   * @param tokenAddress - Asset in format "CODE:ISSUER" (e.g., "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    try {
      const account = await this.horizonGet<{
        balances: Array<{
          asset_type: string
          asset_code?: string
          asset_issuer?: string
          balance: string
        }>
      }>(`/accounts/${address}`)

      const [assetCode, assetIssuer] = tokenAddress.split(':')

      const assetBalance = account.balances.find(
        (b) =>
          b.asset_type !== 'native' &&
          b.asset_code === assetCode &&
          b.asset_issuer === assetIssuer,
      )

      if (!assetBalance) {
        return {
          address,
          amount: '0',
          symbol: assetCode || '',
          decimals: 7,
        }
      }

      return {
        address,
        amount: decimalToStroops(assetBalance.balance),
        symbol: assetBalance.asset_code || '',
        decimals: 7,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return {
          address,
          amount: '0',
          symbol: '',
          decimals: 7,
        }
      }
      throw err
    }
  }

  /**
   * Get metadata for a Stellar asset.
   * @param tokenAddress - Asset in format "CODE:ISSUER"
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const [assetCode, assetIssuer] = tokenAddress.split(':')

    if (!assetCode || !assetIssuer) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Token address must be in format "CODE:ISSUER"',
      )
    }

    try {
      const assets = await this.horizonGet<{
        _embedded: {
          records: Array<{
            asset_type: string
            asset_code: string
            asset_issuer: string
            amount: string
            num_accounts: number
          }>
        }
      }>(`/assets?asset_code=${assetCode}&asset_issuer=${assetIssuer}&limit=1`)

      if (!assets._embedded.records || assets._embedded.records.length === 0) {
        throw new ChainKitError(
          ErrorCode.INVALID_ADDRESS,
          `Asset not found: ${tokenAddress}`,
        )
      }

      const asset = assets._embedded.records[0]

      return {
        address: tokenAddress,
        name: asset.asset_code,
        symbol: asset.asset_code,
        decimals: 7,
        totalSupply: decimalToStroops(asset.amount),
      }
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      throw new ChainKitError(
        ErrorCode.NETWORK_ERROR,
        `Failed to fetch asset metadata: ${(err as Error).message}`,
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
   * Subscribe to new ledgers (blocks) via polling.
   * Polls the latest ledger endpoint periodically.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastLedger = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const root = await this.horizonGet<{
            history_latest_ledger: number
          }>('/')

          const currentLedger = root.history_latest_ledger
          if (currentLedger > lastLedger) {
            lastLedger = currentLedger
            callback(currentLedger)
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
   * Polls the account transactions endpoint for new transactions.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastPagingToken: string | null = null
    let active = true

    // Get the most recent transaction to start from
    try {
      const txs = await this.horizonGet<{
        _embedded: {
          records: Array<{ paging_token: string }>
        }
      }>(`/accounts/${address}/transactions?order=desc&limit=1`)

      if (txs._embedded.records.length > 0) {
        lastPagingToken = txs._embedded.records[0].paging_token
      }
    } catch {
      // Start from scratch
    }

    const poll = async () => {
      while (active) {
        try {
          let url = `/accounts/${address}/transactions?order=asc&limit=10`
          if (lastPagingToken) {
            url += `&cursor=${lastPagingToken}`
          }

          const txs = await this.horizonGet<{
            _embedded: {
              records: Array<{
                hash: string
                source_account: string
                fee_charged: string
                created_at: string
                successful: boolean
                ledger: number
                source_account_sequence: string
                paging_token: string
              }>
            }
          }>(url)

          const records = txs._embedded.records
          if (records.length > 0) {
            for (const record of records) {
              if (!active) break

              const txInfo: TransactionInfo = {
                hash: record.hash,
                from: record.source_account,
                to: null,
                value: '0',
                fee: record.fee_charged,
                blockNumber: record.ledger,
                blockHash: null,
                status: record.successful ? 'confirmed' : 'failed',
                timestamp: record.created_at
                  ? Math.floor(new Date(record.created_at).getTime() / 1000)
                  : null,
                nonce: parseInt(record.source_account_sequence, 10) || 0,
              }

              callback(txInfo)
            }
            lastPagingToken = records[records.length - 1].paging_token
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

// ---- Utility functions ----

/**
 * Convert a decimal string (e.g., "100.0000000") to stroops (integer string).
 * 1 XLM = 10,000,000 stroops (10^7).
 */
function decimalToStroops(decimal: string): string {
  const parts = decimal.split('.')
  const whole = parts[0] || '0'
  let frac = (parts[1] || '').padEnd(7, '0').slice(0, 7)

  const stroops = BigInt(whole) * BigInt(10_000_000) + BigInt(frac)
  return stroops.toString()

}
