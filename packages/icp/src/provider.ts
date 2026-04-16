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
 * Configuration for the ICP provider.
 */
export interface IcpProviderConfig {
  /** Rosetta API endpoint (default: https://rosetta-api.internetcomputer.org) */
  rosettaEndpoint?: string
  /** IC HTTP API endpoint (default: https://ic0.app) */
  icEndpoint?: string
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number
}

/**
 * ICP (Internet Computer) provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses the Rosetta API for balance and transaction queries,
 * and the IC HTTP API for canister interactions.
 */
export class IcpProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rosettaEndpoint: string
  private readonly icEndpoint: string
  private readonly timeout: number

  /** Rosetta network identifier for ICP mainnet */
  private readonly networkIdentifier = {
    blockchain: 'Internet Computer',
    network: '00000000000000020101',
  }

  constructor(config?: IcpProviderConfig) {
    this.rosettaEndpoint = config?.rosettaEndpoint ?? 'https://rosetta-api.internetcomputer.org'
    this.icEndpoint = config?.icEndpoint ?? 'https://ic0.app'
    this.timeout = config?.timeout ?? 30000
  }

  /**
   * Make a POST request to the Rosetta API.
   */
  private async rosettaRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.rosettaEndpoint}${path}`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        throw new ChainKitError(
          ErrorCode.RPC_ERROR,
          `Rosetta API error (${response.status}): ${errorText}`,
        )
      }

      return (await response.json()) as T
    } catch (error) {
      if (error instanceof ChainKitError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Rosetta API request timed out: ${path}`)
      }
      throw new ChainKitError(
        ErrorCode.RPC_ERROR,
        `Rosetta API request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // ------- ChainProvider -------

  /**
   * Get the ICP balance of an account.
   * Uses the Rosetta /account/balance endpoint.
   *
   * @param address - Account identifier (64-char hex string)
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.rosettaRequest<{
      balances: Array<{ value: string; currency: { symbol: string; decimals: number } }>
    }>('/account/balance', {
      network_identifier: this.networkIdentifier,
      account_identifier: { address },
    })

    if (result.balances && result.balances.length > 0) {
      const balance = result.balances[0]
      return {
        address,
        amount: balance.value,
        symbol: balance.currency.symbol,
        decimals: balance.currency.decimals,
      }
    }

    return {
      address,
      amount: '0',
      symbol: 'ICP',
      decimals: 8,
    }
  }

  /**
   * Get transaction details by hash.
   * Uses the Rosetta /search/transactions endpoint.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const result = await this.rosettaRequest<{
        transactions: Array<{
          block_identifier: { index: number; hash: string }
          transaction: {
            transaction_identifier: { hash: string }
            operations: Array<{
              type: string
              status: string
              account: { address: string }
              amount: { value: string; currency: { symbol: string; decimals: number } }
            }>
            metadata?: { block_height: number; memo: number; timestamp: number }
          }
        }>
        total_count: number
      }>('/search/transactions', {
        network_identifier: this.networkIdentifier,
        transaction_identifier: { hash },
      })

      if (!result.transactions || result.transactions.length === 0) {
        return null
      }

      const txEntry = result.transactions[0]
      const tx = txEntry.transaction
      const operations = tx.operations

      // Find TRANSFER operations to determine from/to/value
      let from = ''
      let to: string | null = null
      let value = '0'
      let fee = '0'
      let status: 'pending' | 'confirmed' | 'failed' = 'confirmed'

      for (const op of operations) {
        if (op.type === 'TRANSFER' || op.type === 'TRANSACTION') {
          const amount = BigInt(op.amount?.value ?? '0')
          if (amount < 0n) {
            from = op.account.address
          } else if (amount > 0n) {
            to = op.account.address
            value = amount.toString()
          }
        } else if (op.type === 'FEE') {
          const feeAmount = BigInt(op.amount?.value ?? '0')
          fee = (feeAmount < 0n ? -feeAmount : feeAmount).toString()
        }

        if (op.status === 'FAILED') {
          status = 'failed'
        }
      }

      const timestamp = tx.metadata?.timestamp
        ? Math.floor(tx.metadata.timestamp / 1_000_000_000)
        : null

      return {
        hash: tx.transaction_identifier.hash,
        from,
        to,
        value,
        fee,
        blockNumber: txEntry.block_identifier.index,
        blockHash: txEntry.block_identifier.hash,
        status,
        timestamp,
      }
    } catch (error) {
      if (error instanceof ChainKitError) throw error
      return null
    }
  }

  /**
   * Get block details by index (height) or hash.
   * Uses the Rosetta /block endpoint.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    const blockIdentifier: Record<string, unknown> = {}

    if (typeof hashOrNumber === 'number') {
      blockIdentifier.index = hashOrNumber
    } else if (/^\d+$/.test(hashOrNumber)) {
      blockIdentifier.index = parseInt(hashOrNumber, 10)
    } else {
      blockIdentifier.hash = hashOrNumber
    }

    try {
      const result = await this.rosettaRequest<{
        block: {
          block_identifier: { index: number; hash: string }
          parent_block_identifier: { index: number; hash: string }
          timestamp: number
          transactions: Array<{
            transaction_identifier: { hash: string }
          }>
        }
      }>('/block', {
        network_identifier: this.networkIdentifier,
        block_identifier: blockIdentifier,
      })

      if (!result.block) return null

      const block = result.block
      return {
        number: block.block_identifier.index,
        hash: block.block_identifier.hash,
        parentHash: block.parent_block_identifier.hash,
        timestamp: Math.floor(block.timestamp / 1000),
        transactions: block.transactions.map((tx) => tx.transaction_identifier.hash),
      }
    } catch {
      return null
    }
  }

  /**
   * Get the nonce for an account.
   * Uses the Rosetta API to query the latest transaction count.
   * ICP does not use sequential nonces in the traditional sense.
   */
  async getNonce(address: Address): Promise<number> {
    try {
      const result = await this.rosettaRequest<{
        transactions: Array<unknown>
        total_count: number
      }>('/search/transactions', {
        network_identifier: this.networkIdentifier,
        account_identifier: { address },
        limit: 1,
      })
      return result.total_count ?? 0
    } catch {
      return 0
    }
  }

  /**
   * Estimate transaction fees for ICP.
   * ICP has a fixed transaction fee of 10,000 e8s (0.0001 ICP).
   */
  async estimateFee(): Promise<FeeEstimate> {
    // ICP has a fixed fee
    const fee = '10000'
    return {
      slow: fee,
      average: fee,
      fast: fee,
      unit: 'e8s',
    }
  }

  /**
   * Broadcast a signed transaction to the ICP network.
   * Uses the Rosetta /construction/submit endpoint.
   *
   * @param signedTx - The CBOR-encoded signed transaction as a hex string
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const result = await this.rosettaRequest<{
      transaction_identifier: { hash: string }
    }>('/construction/submit', {
      network_identifier: this.networkIdentifier,
      signed_transaction: signedTx,
    })

    return result.transaction_identifier.hash
  }

  /**
   * Get ICP chain/network information.
   * Uses the Rosetta /network/status endpoint.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const result = await this.rosettaRequest<{
      current_block_identifier: { index: number; hash: string }
      genesis_block_identifier: { index: number; hash: string }
      current_block_timestamp: number
      sync_status?: { stage: string }
    }>('/network/status', {
      network_identifier: this.networkIdentifier,
    })

    return {
      chainId: this.networkIdentifier.network,
      name: 'Internet Computer',
      symbol: 'ICP',
      decimals: 8,
      testnet: false,
      blockHeight: result.current_block_identifier.index,
    }
  }

  // ------- ContractCapable (Canisters) -------

  /**
   * Call a read-only canister method (query call).
   *
   * @param contractAddress - The canister ID (principal text)
   * @param method - The method name to call
   * @param params - Optional parameters (Candid-encoded as hex in first element)
   * @returns The raw response from the canister
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    const arg = params && params.length > 0 ? String(params[0]) : ''

    const url = `${this.icEndpoint}/api/v2/canister/${contractAddress}/query`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const body: Record<string, unknown> = {
        request_type: 'query',
        canister_id: contractAddress,
        method_name: method,
        arg: arg,
        sender: '04', // anonymous principal
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/cbor' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        throw new ChainKitError(
          ErrorCode.TRANSACTION_FAILED,
          `Canister query failed (${response.status}): ${errorText}`,
        )
      }

      return await response.json()
    } catch (error) {
      if (error instanceof ChainKitError) throw error
      throw new ChainKitError(
        ErrorCode.RPC_ERROR,
        `Canister query failed: ${error instanceof Error ? error.message : String(error)}`,
        { canisterId: contractAddress, method },
      )
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Estimate cycles (gas equivalent) for a canister call.
   * ICP uses cycles for computation; this returns a rough estimate.
   */
  async estimateGas(
    _contractAddress: Address,
    _method: string,
    _params?: unknown[],
  ): Promise<string> {
    // ICP cycle costs vary by operation; return a reasonable default
    // Standard update call cost is ~590,000 cycles
    return '590000'
  }

  // ------- TokenCapable (ICRC-1) -------

  /**
   * Get the ICRC-1 token balance for an account.
   *
   * @param address - The account owner (principal text or account identifier)
   * @param tokenAddress - The token canister ID (principal text)
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    try {
      const result = await this.callContract(tokenAddress, 'icrc1_balance_of', [
        { owner: address, subaccount: null },
      ]) as { Ok?: string; value?: string }

      const amount = result?.Ok ?? result?.value ?? '0'

      // Try to get token metadata
      let symbol = ''
      let decimals = 8
      try {
        const metadata = await this.getTokenMetadata(tokenAddress)
        symbol = metadata.symbol
        decimals = metadata.decimals
      } catch {
        // Use defaults
      }

      return {
        address,
        amount: String(amount),
        symbol,
        decimals,
      }
    } catch {
      return {
        address,
        amount: '0',
        symbol: '',
        decimals: 8,
      }
    }
  }

  /**
   * Get metadata for an ICRC-1 token.
   *
   * @param tokenAddress - The token canister ID (principal text)
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    try {
      const [nameResult, symbolResult, decimalsResult, supplyResult] = await Promise.all([
        this.callContract(tokenAddress, 'icrc1_name', []).catch(() => null),
        this.callContract(tokenAddress, 'icrc1_symbol', []).catch(() => null),
        this.callContract(tokenAddress, 'icrc1_decimals', []).catch(() => null),
        this.callContract(tokenAddress, 'icrc1_total_supply', []).catch(() => null),
      ])

      return {
        address: tokenAddress,
        name: String(nameResult ?? ''),
        symbol: String(symbolResult ?? ''),
        decimals: Number(decimalsResult ?? 8),
        totalSupply: supplyResult ? String(supplyResult) : undefined,
      }
    } catch {
      return {
        address: tokenAddress,
        name: '',
        symbol: '',
        decimals: 8,
      }
    }
  }

  /**
   * Get balances for multiple ICRC-1 tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Uses the Rosetta /network/status endpoint to poll for new block heights.
   * Polls every ~2 seconds (ICP has ~1 second block time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockHeight = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const status = await this.rosettaRequest<{
            current_block_identifier: { index: number }
          }>('/network/status', {
            network_identifier: this.networkIdentifier,
          })

          const currentHeight = status.current_block_identifier.index
          if (currentHeight > lastBlockHeight) {
            lastBlockHeight = currentHeight
            callback(currentHeight)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
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
   * Uses the Rosetta /search/transactions endpoint.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastBlockHeight = 0
    let active = true

    // Initialize with current block height
    try {
      const status = await this.rosettaRequest<{
        current_block_identifier: { index: number }
      }>('/network/status', {
        network_identifier: this.networkIdentifier,
      })
      lastBlockHeight = status.current_block_identifier.index
    } catch {
      // Start from 0
    }

    const poll = async () => {
      while (active) {
        try {
          const result = await this.rosettaRequest<{
            transactions: Array<{
              block_identifier: { index: number; hash: string }
              transaction: {
                transaction_identifier: { hash: string }
                operations: Array<{
                  type: string
                  status: string
                  account: { address: string }
                  amount: { value: string }
                }>
                metadata?: { timestamp: number }
              }
            }>
            total_count: number
          }>('/search/transactions', {
            network_identifier: this.networkIdentifier,
            account_identifier: { address },
            limit: 10,
          })

          if (result.transactions) {
            for (const txEntry of result.transactions) {
              if (txEntry.block_identifier.index > lastBlockHeight) {
                const txInfo = await this.getTransaction(
                  txEntry.transaction.transaction_identifier.hash,
                )
                if (txInfo) {
                  callback(txInfo)
                }
              }
            }

            // Update last block height
            for (const txEntry of result.transactions) {
              if (txEntry.block_identifier.index > lastBlockHeight) {
                lastBlockHeight = txEntry.block_identifier.index
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
