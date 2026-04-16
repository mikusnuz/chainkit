import {
  RpcManager,
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
  RpcManagerConfig,
} from '@chainkit/core'

/**
 * Helper to pass NEAR's named (object) params through RpcManager.request,
 * which is typed as `unknown[]`. The underlying JSON-RPC transport serializes
 * this correctly since JSON-RPC 2.0 allows both arrays and objects for params.
 */
function namedParams(obj: Record<string, unknown>): unknown[] {
  return obj as unknown as unknown[]
}

/**
 * NEAR provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses NEAR JSON-RPC via an internal RpcManager.
 */
export class NearProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the NEAR balance of an address.
   * Uses the `query` RPC method with `view_account` request type.
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.rpc.request<{
      amount: string
      locked: string
      code_hash: string
      storage_usage: number
      block_height: number
      block_hash: string
    }>('query', namedParams({
      request_type: 'view_account',
      finality: 'final',
      account_id: address,
    }))

    return {
      address,
      amount: result.amount,
      symbol: 'NEAR',
      decimals: 24,
    }
  }

  /**
   * Get transaction details by hash.
   * Uses the `tx` RPC method.
   * @param hash - Transaction hash in the format "txHash:senderId" or just "txHash"
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    // NEAR tx RPC requires [tx_hash, sender_account_id]
    // If the hash contains ":", split it; otherwise use empty sender
    let txHash: string
    let senderId: string
    if (hash.includes(':')) {
      const parts = hash.split(':')
      txHash = parts[0]
      senderId = parts[1]
    } else {
      txHash = hash
      senderId = ''
    }

    try {
      const tx = await this.rpc.request<Record<string, unknown>>('tx', [
        txHash,
        senderId,
      ])

      if (!tx) return null

      const transaction = tx.transaction as Record<string, unknown>
      const transactionOutcome = tx.transaction_outcome as Record<string, unknown>
      const outcome = transactionOutcome.outcome as Record<string, unknown>
      const status = tx.status as Record<string, unknown>

      // Determine transaction status
      let txStatus: 'pending' | 'confirmed' | 'failed' = 'confirmed'
      if (status.Failure) {
        txStatus = 'failed'
      }

      // Extract gas burnt as fee
      const tokensBurnt = (outcome.tokens_burnt as string) ?? '0'

      // Get block info for timestamp
      const blockHash = transactionOutcome.block_hash as string
      let timestamp: number | null = null
      try {
        const block = await this.rpc.request<Record<string, unknown>>(
          'block',
          namedParams({ block_id: blockHash }),
        )
        if (block) {
          const header = block.header as Record<string, unknown>
          // NEAR timestamp is in nanoseconds
          const timestampNs = header.timestamp as number
          timestamp = Math.floor(timestampNs / 1_000_000_000)
        }
      } catch {
        // Ignore block fetch errors
      }

      const receiverId = transaction.receiver_id as string
      const signerId = transaction.signer_id as string
      const nonce = transaction.nonce as number

      return {
        hash: txHash,
        from: signerId,
        to: receiverId,
        value: '0', // NEAR transfer amounts are in actions, not a top-level value
        fee: tokensBurnt,
        blockNumber: null,
        blockHash,
        status: txStatus,
        timestamp,
        nonce,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get block details by number (height) or hash.
   * Uses the `block` RPC method.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      let blockId: string | number
      if (typeof hashOrNumber === 'number') {
        blockId = hashOrNumber
      } else if (/^\d+$/.test(hashOrNumber)) {
        blockId = parseInt(hashOrNumber, 10)
      } else {
        blockId = hashOrNumber
      }

      const block = await this.rpc.request<Record<string, unknown>>(
        'block',
        namedParams({ block_id: blockId }),
      )

      if (!block) return null

      const header = block.header as Record<string, unknown>

      // NEAR timestamp is in nanoseconds
      const timestampNs = header.timestamp as number
      const timestamp = Math.floor(timestampNs / 1_000_000_000)

      return {
        number: header.height as number,
        hash: header.hash as string,
        parentHash: header.prev_hash as string,
        timestamp,
        transactions: [],
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get the access key nonce for a NEAR account.
   * Queries the access key for the given address and returns the nonce.
   */
  async getNonce(address: Address): Promise<number> {
    try {
      const result = await this.rpc.request<{
        keys: Array<{ access_key: { nonce: number } }>
      }>('query', namedParams({
        request_type: 'view_access_key_list',
        finality: 'final',
        account_id: address,
      }))
      // Return the nonce from the first key, or 0 if none
      if (result.keys && result.keys.length > 0) {
        return result.keys[0].access_key.nonce
      }
      return 0
    } catch {
      return 0
    }
  }

  /**
   * Estimate transaction fees on NEAR.
   * Uses the `gas_price` RPC method.
   */
  async estimateFee(): Promise<FeeEstimate> {
    try {
      const result = await this.rpc.request<{
        gas_price: string
      }>('gas_price', [null])

      const gasPrice = BigInt(result.gas_price)
      // Standard transfer uses ~2.5 Tgas
      const standardGas = 2_500_000_000_000n
      // Contract call uses ~30 Tgas
      const contractGas = 30_000_000_000_000n

      const slow = (gasPrice * standardGas).toString()
      const average = (gasPrice * (standardGas + contractGas) / 2n).toString()
      const fast = (gasPrice * contractGas).toString()

      return {
        slow,
        average,
        fast,
        unit: 'yoctoNEAR',
      }
    } catch {
      // Default gas price: 100M yoctoNEAR per gas unit
      return {
        slow: '250000000000000000000',    // 2.5 Tgas * 100M
        average: '1625000000000000000000', // 16.25 Tgas * 100M
        fast: '3000000000000000000000',    // 30 Tgas * 100M
        unit: 'yoctoNEAR',
      }
    }
  }

  /**
   * Broadcast a signed transaction to the NEAR network.
   * Uses the `broadcast_tx_commit` RPC method.
   * Expects base64-encoded signed transaction.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const result = await this.rpc.request<Record<string, unknown>>('broadcast_tx_commit', [
      signedTx,
    ])

    const txOutcome = result.transaction_outcome as Record<string, unknown>
    return txOutcome.id as string
  }

  /**
   * Get NEAR chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [status, block] = await Promise.all([
      this.rpc.request<Record<string, unknown>>('status', []),
      this.rpc.request<Record<string, unknown>>(
        'block',
        namedParams({ finality: 'final' }),
      ),
    ])

    const header = block.header as Record<string, unknown>
    const blockHeight = header.height as number
    const chainId = (status.chain_id as string) ?? 'near'

    const isTestnet = chainId.includes('testnet') || chainId.includes('localnet')

    let name = 'NEAR'
    if (chainId === 'mainnet') {
      name = 'NEAR Mainnet'
    } else if (chainId === 'testnet') {
      name = 'NEAR Testnet'
    } else {
      name = `NEAR (${chainId})`
    }

    return {
      chainId,
      name,
      symbol: 'NEAR',
      decimals: 24,
      testnet: isTestnet,
      blockHeight,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only contract method via `query` RPC.
   * @param contractAddress - The contract account ID
   * @param method - The method name to call
   * @param params - Method arguments (will be base64-encoded JSON)
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    const argsBase64 = params && params.length > 0
      ? btoa(JSON.stringify(params[0]))
      : btoa('{}')

    const result = await this.rpc.request<{
      result: number[]
      logs: string[]
      block_height: number
      block_hash: string
    }>('query', namedParams({
      request_type: 'call_function',
      finality: 'final',
      account_id: contractAddress,
      method_name: method,
      args_base64: argsBase64,
    }))

    // Decode result bytes to JSON
    const resultBytes = new Uint8Array(result.result)
    const resultStr = new TextDecoder().decode(resultBytes)

    try {
      return JSON.parse(resultStr)
    } catch {
      return resultStr
    }
  }

  /**
   * Estimate gas for a contract call.
   * NEAR doesn't have a direct gas estimation RPC, so we return
   * a standard gas allowance based on common usage patterns.
   */
  async estimateGas(
    _contractAddress: Address,
    method: string,
    _params?: unknown[],
  ): Promise<string> {
    // Standard gas for contract calls: 30 Tgas
    // Simple transfers: 2.5 Tgas
    if (method === 'transfer' || method === 'send') {
      return '2500000000000'
    }
    return '30000000000000'
  }

  // ------- TokenCapable -------

  /**
   * Get the NEP-141 fungible token balance for an address.
   * Calls the `ft_balance_of` view method on the token contract.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    try {
      const argsBase64 = btoa(JSON.stringify({ account_id: address }))

      const [balanceResult, metadataResult] = await Promise.all([
        this.rpc.request<{
          result: number[]
          logs: string[]
        }>('query', namedParams({
          request_type: 'call_function',
          finality: 'final',
          account_id: tokenAddress,
          method_name: 'ft_balance_of',
          args_base64: argsBase64,
        })),
        this.rpc.request<{
          result: number[]
          logs: string[]
        }>('query', namedParams({
          request_type: 'call_function',
          finality: 'final',
          account_id: tokenAddress,
          method_name: 'ft_metadata',
          args_base64: btoa('{}'),
        })).catch(() => null),
      ])

      // Decode balance
      const balanceStr = new TextDecoder().decode(new Uint8Array(balanceResult.result))
      const amount = JSON.parse(balanceStr) as string

      // Decode metadata
      let symbol = ''
      let decimals = 0
      if (metadataResult) {
        const metadataStr = new TextDecoder().decode(new Uint8Array(metadataResult.result))
        const metadata = JSON.parse(metadataStr) as Record<string, unknown>
        symbol = (metadata.symbol as string) ?? ''
        decimals = (metadata.decimals as number) ?? 0
      }

      return {
        address,
        amount,
        symbol,
        decimals,
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
   * Get metadata for a NEP-141 fungible token.
   * Calls the `ft_metadata` view method on the token contract.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const argsBase64 = btoa('{}')

    const [metadataResult, supplyResult] = await Promise.all([
      this.rpc.request<{
        result: number[]
        logs: string[]
      }>('query', namedParams({
        request_type: 'call_function',
        finality: 'final',
        account_id: tokenAddress,
        method_name: 'ft_metadata',
        args_base64: argsBase64,
      })),
      this.rpc.request<{
        result: number[]
        logs: string[]
      }>('query', namedParams({
        request_type: 'call_function',
        finality: 'final',
        account_id: tokenAddress,
        method_name: 'ft_total_supply',
        args_base64: argsBase64,
      })).catch(() => null),
    ])

    const metadataStr = new TextDecoder().decode(new Uint8Array(metadataResult.result))
    const metadata = JSON.parse(metadataStr) as Record<string, unknown>

    let totalSupply: string | undefined
    if (supplyResult) {
      const supplyStr = new TextDecoder().decode(new Uint8Array(supplyResult.result))
      totalSupply = JSON.parse(supplyStr) as string
    }

    return {
      address: tokenAddress,
      name: (metadata.name as string) ?? '',
      symbol: (metadata.symbol as string) ?? '',
      decimals: (metadata.decimals as number) ?? 0,
      totalSupply,
    }
  }

  /**
   * Get balances for multiple NEP-141 tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Polls every ~1 second (NEAR block time is ~1s).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockHeight = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const block = await this.rpc.request<Record<string, unknown>>(
            'block',
            namedParams({ finality: 'final' }),
          )
          const header = block.header as Record<string, unknown>
          const height = header.height as number

          if (height > lastBlockHeight) {
            lastBlockHeight = height
            callback(height)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
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
   * Polls for account changes by checking the block height.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastBlockHeight = 0
    let active = true

    // Initialize with current block height
    try {
      const block = await this.rpc.request<Record<string, unknown>>(
        'block',
        namedParams({ finality: 'final' }),
      )
      const header = block.header as Record<string, unknown>
      lastBlockHeight = header.height as number
    } catch {
      // Start from 0
    }

    const poll = async () => {
      while (active) {
        try {
          const block = await this.rpc.request<Record<string, unknown>>(
            'block',
            namedParams({ finality: 'final' }),
          )
          const header = block.header as Record<string, unknown>
          const currentHeight = header.height as number

          if (currentHeight > lastBlockHeight) {
            // Check for transactions involving this address in the new blocks
            // NEAR doesn't have a direct "get transactions by address" RPC,
            // so we check changes to the account
            try {
              const changes = await this.rpc.request<Record<string, unknown>>(
                'EXPERIMENTAL_changes',
                namedParams({
                  changes_type: 'account_changes',
                  account_ids: [address],
                  block_id: currentHeight,
                }),
              )

              const changesArray = (changes.changes as unknown[]) ?? []
              if (changesArray.length > 0) {
                // Account had changes, notify with a minimal TransactionInfo
                callback({
                  hash: `block:${currentHeight}`,
                  from: address,
                  to: null,
                  value: '0',
                  fee: '0',
                  blockNumber: currentHeight,
                  blockHash: header.hash as string,
                  status: 'confirmed',
                  timestamp: Math.floor((header.timestamp as number) / 1_000_000_000),
                })
              }
            } catch {
              // Ignore changes query errors
            }

            lastBlockHeight = currentHeight
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
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
