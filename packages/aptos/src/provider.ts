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
 * Configuration for AptosProvider.
 */
export interface AptosProviderConfig {
  /** Aptos REST API base URL (e.g., "https://fullnode.mainnet.aptoslabs.com") */
  baseUrl: string
}

/**
 * Make an HTTP request to the Aptos REST API.
 */
async function aptosRequest<T>(baseUrl: string, path: string, options?: RequestInit): Promise<T> {
  const url = `${baseUrl}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ChainKitError(
      ErrorCode.RPC_ERROR,
      `Aptos API error: ${res.status} ${res.statusText} - ${body}`,
    )
  }

  return res.json() as Promise<T>
}

/**
 * Aptos provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses the Aptos REST API to interact with the Aptos blockchain.
 */
export class AptosProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly baseUrl: string

  constructor(config: AptosProviderConfig) {
    // Remove trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
  }

  // ------- ChainProvider -------

  /**
   * Get the APT balance of an address.
   * Reads the CoinStore resource for 0x1::aptos_coin::AptosCoin.
   */
  async getBalance(address: Address): Promise<Balance> {
    interface CoinStoreResource {
      type: string
      data: {
        coin: {
          value: string
        }
      }
    }

    try {
      const resource = await aptosRequest<CoinStoreResource>(
        this.baseUrl,
        `/v1/accounts/${address}/resource/0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>`,
      )

      return {
        address,
        amount: resource.data.coin.value,
        symbol: 'APT',
        decimals: 8,
      }
    } catch (error) {
      // If resource not found, balance is 0
      if (error instanceof ChainKitError && error.message.includes('404')) {
        return {
          address,
          amount: '0',
          symbol: 'APT',
          decimals: 8,
        }
      }
      throw error
    }
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    interface AptosTransaction {
      hash: string
      sender: string
      sequence_number: string
      max_gas_amount: string
      gas_unit_price: string
      gas_used: string
      success: boolean
      version: string
      timestamp: string
      payload?: {
        function?: string
        arguments?: string[]
      }
      type: string
    }

    try {
      const tx = await aptosRequest<AptosTransaction>(
        this.baseUrl,
        `/v1/transactions/by_hash/${hash}`,
      )

      // Determine to address and value from payload
      let to: string | null = null
      let value = '0'
      if (tx.payload?.function === '0x1::aptos_account::transfer' ||
          tx.payload?.function === '0x1::coin::transfer') {
        to = tx.payload.arguments?.[0] ?? null
        value = tx.payload.arguments?.[1] ?? '0'
      }

      const gasUsed = BigInt(tx.gas_used ?? '0')
      const gasUnitPrice = BigInt(tx.gas_unit_price ?? '0')
      const fee = (gasUsed * gasUnitPrice).toString()

      // Aptos timestamps are in microseconds
      const timestamp = tx.timestamp
        ? Math.floor(Number(tx.timestamp) / 1_000_000)
        : null

      return {
        hash: tx.hash,
        from: tx.sender,
        to,
        value,
        fee,
        blockNumber: tx.version ? Number(tx.version) : null,
        blockHash: null,
        status: tx.success ? 'confirmed' : 'failed',
        timestamp,
        nonce: Number(tx.sequence_number),
      }
    } catch (error) {
      if (error instanceof ChainKitError && error.message.includes('404')) {
        return null
      }
      throw error
    }
  }

  /**
   * Get block details by number (version) or hash.
   * Aptos uses "block by height" endpoint.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    interface AptosBlock {
      block_height: string
      block_hash: string
      block_timestamp: string
      first_version: string
      last_version: string
      transactions?: Array<{ hash: string }>
    }

    try {
      let block: AptosBlock

      if (typeof hashOrNumber === 'number') {
        block = await aptosRequest<AptosBlock>(
          this.baseUrl,
          `/v1/blocks/by_height/${hashOrNumber}?with_transactions=true`,
        )
      } else {
        // Try as block height string
        block = await aptosRequest<AptosBlock>(
          this.baseUrl,
          `/v1/blocks/by_height/${hashOrNumber}?with_transactions=true`,
        )
      }

      // Aptos timestamps are in microseconds
      const timestamp = Math.floor(Number(block.block_timestamp) / 1_000_000)

      const transactions = block.transactions
        ? block.transactions.map((tx) => tx.hash)
        : []

      return {
        number: Number(block.block_height),
        hash: block.block_hash,
        parentHash: '', // Aptos REST API doesn't directly expose parent hash
        timestamp,
        transactions,
      }
    } catch (error) {
      if (error instanceof ChainKitError && error.message.includes('404')) {
        return null
      }
      throw error
    }
  }

  /**
   * Get the sequence number (nonce) for an account.
   * Uses GET /v1/accounts/{address} to read the sequence_number field.
   */
  async getNonce(address: Address): Promise<number> {
    const account = await aptosRequest<{ sequence_number: string }>(
      this.baseUrl,
      `/v1/accounts/${address}`,
    )
    return Number(account.sequence_number)
  }

  /**
   * Estimate transaction fees.
   * Uses the gas estimation endpoint.
   */
  async estimateFee(): Promise<FeeEstimate> {
    interface GasEstimate {
      gas_estimate: number
      deprioritized_gas_estimate?: number
      prioritized_gas_estimate?: number
    }

    const estimate = await aptosRequest<GasEstimate>(
      this.baseUrl,
      '/v1/estimate_gas_price',
    )

    const slow = (estimate.deprioritized_gas_estimate ?? estimate.gas_estimate).toString()
    const average = estimate.gas_estimate.toString()
    const fast = (estimate.prioritized_gas_estimate ?? estimate.gas_estimate).toString()

    return {
      slow,
      average,
      fast,
      unit: 'octa',
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   * Expects the signed transaction as a BCS-serialized hex string.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    // Strip 0x prefix for conversion to bytes
    const hex = signedTx.startsWith('0x') ? signedTx.slice(2) : signedTx
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
    }

    const result = await aptosRequest<{ hash: string }>(
      this.baseUrl,
      '/v1/transactions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x.aptos.signed_transaction+bcs',
        },
        body: bytes,
      },
    )

    return result.hash
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    interface LedgerInfo {
      chain_id: number
      epoch: string
      ledger_version: string
      oldest_ledger_version: string
      ledger_timestamp: string
      node_role: string
    }

    const info = await aptosRequest<LedgerInfo>(this.baseUrl, '/v1')

    const chainNames: Record<number, { name: string; testnet: boolean }> = {
      1: { name: 'Aptos Mainnet', testnet: false },
      2: { name: 'Aptos Testnet', testnet: true },
      4: { name: 'Aptos Devnet', testnet: true },
    }

    const chainInfo = chainNames[info.chain_id] ?? {
      name: `Aptos Chain ${info.chain_id}`,
      testnet: info.chain_id !== 1,
    }

    return {
      chainId: info.chain_id.toString(),
      name: chainInfo.name,
      symbol: 'APT',
      decimals: 8,
      testnet: chainInfo.testnet,
      blockHeight: Number(info.ledger_version),
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only Move view function.
   * @param contractAddress - The module address (e.g., "0x1")
   * @param method - The function identifier (e.g., "0x1::coin::balance")
   * @param params - Function type arguments and arguments
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // For Aptos, method is the full function path: "module::function"
    // contractAddress is used as part of the function identifier if method doesn't include it
    const functionId = method.includes('::') ? method : `${contractAddress}::${method}`

    const payload = {
      function: functionId,
      type_arguments: (params?.[0] as string[]) ?? [],
      arguments: (params?.[1] as unknown[]) ?? [],
    }

    return aptosRequest(this.baseUrl, '/v1/view', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  /**
   * Estimate gas for a transaction.
   * Uses the gas estimation endpoint to get the current gas unit price,
   * and returns a default max gas amount.
   */
  async estimateGas(
    _contractAddress: Address,
    _method: string,
    _params?: unknown[],
  ): Promise<string> {
    interface GasEstimate {
      gas_estimate: number
    }

    const estimate = await aptosRequest<GasEstimate>(
      this.baseUrl,
      '/v1/estimate_gas_price',
    )

    // Return gas unit price as string; actual gas used depends on transaction complexity
    return estimate.gas_estimate.toString()
  }

  // ------- TokenCapable -------

  /**
   * Get the balance of a specific coin type for an address.
   * @param address - The holder address
   * @param tokenAddress - The full coin type (e.g., "0x1::aptos_coin::AptosCoin")
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    interface CoinStoreResource {
      type: string
      data: {
        coin: {
          value: string
        }
      }
    }

    try {
      const resource = await aptosRequest<CoinStoreResource>(
        this.baseUrl,
        `/v1/accounts/${address}/resource/0x1::coin::CoinStore<${tokenAddress}>`,
      )

      // Try to get coin info for metadata
      let symbol = tokenAddress.split('::').pop() ?? 'UNKNOWN'
      let decimals = 8

      try {
        const moduleAddress = tokenAddress.split('::')[0]
        interface CoinInfoResource {
          data: {
            symbol: string
            decimals: number
          }
        }
        const coinInfo = await aptosRequest<CoinInfoResource>(
          this.baseUrl,
          `/v1/accounts/${moduleAddress}/resource/0x1::coin::CoinInfo<${tokenAddress}>`,
        )
        symbol = coinInfo.data.symbol
        decimals = coinInfo.data.decimals
      } catch {
        // Use defaults if coin info is not found
      }

      return {
        address,
        amount: resource.data.coin.value,
        symbol,
        decimals,
      }
    } catch (error) {
      if (error instanceof ChainKitError && error.message.includes('404')) {
        return {
          address,
          amount: '0',
          symbol: tokenAddress.split('::').pop() ?? 'UNKNOWN',
          decimals: 8,
        }
      }
      throw error
    }
  }

  /**
   * Get metadata for a coin type.
   * @param tokenAddress - The full coin type (e.g., "0x1::aptos_coin::AptosCoin")
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const moduleAddress = tokenAddress.split('::')[0]

    interface CoinInfoResource {
      data: {
        name: string
        symbol: string
        decimals: number
        supply?: {
          vec: Array<{
            integer?: {
              vec: Array<{ value: string }>
            }
          }>
        }
      }
    }

    const coinInfo = await aptosRequest<CoinInfoResource>(
      this.baseUrl,
      `/v1/accounts/${moduleAddress}/resource/0x1::coin::CoinInfo<${tokenAddress}>`,
    )

    let totalSupply: string | undefined
    if (coinInfo.data.supply?.vec?.[0]?.integer?.vec?.[0]?.value) {
      totalSupply = coinInfo.data.supply.vec[0].integer.vec[0].value
    }

    return {
      address: tokenAddress,
      name: coinInfo.data.name,
      symbol: coinInfo.data.symbol,
      decimals: coinInfo.data.decimals,
      totalSupply,
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
   * Polls every ~4 seconds (approximate Aptos block time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastVersion = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          interface LedgerInfo {
            ledger_version: string
          }

          const info = await aptosRequest<LedgerInfo>(this.baseUrl, '/v1')
          const currentVersion = Number(info.ledger_version)

          if (currentVersion > lastVersion) {
            lastVersion = currentVersion
            callback(currentVersion)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 4000))
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
   * Polls every ~4 seconds and checks for new transactions.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastSeenVersion = '0'
    let active = true

    const poll = async () => {
      while (active) {
        try {
          interface AptosAccountTransaction {
            hash: string
            version: string
          }

          const txs = await aptosRequest<AptosAccountTransaction[]>(
            this.baseUrl,
            `/v1/accounts/${address}/transactions?limit=10`,
          )

          for (const tx of txs) {
            if (BigInt(tx.version) > BigInt(lastSeenVersion)) {
              const txInfo = await this.getTransaction(tx.hash)
              if (txInfo) {
                callback(txInfo)
              }
            }
          }

          if (txs.length > 0) {
            const maxVersion = txs.reduce(
              (max, tx) => (BigInt(tx.version) > BigInt(max) ? tx.version : max),
              lastSeenVersion,
            )
            lastSeenVersion = maxVersion
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 4000))
        }
      }
    }

    // Initialize lastSeenVersion
    try {
      interface AptosAccountTransaction {
        version: string
      }

      const txs = await aptosRequest<AptosAccountTransaction[]>(
        this.baseUrl,
        `/v1/accounts/${address}/transactions?limit=1`,
      )
      if (txs.length > 0) {
        lastSeenVersion = txs[0].version
      }
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
