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
import type { SuiFeeDetail } from './types.js'

/**
 * Sui provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses Sui JSON-RPC to interact with Sui nodes.
 */
export class SuiProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the SUI balance of an address.
   * Uses suix_getBalance with coin type "0x2::sui::SUI".
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.rpc.request<{
      coinType: string
      coinObjectCount: number
      totalBalance: string
      lockedBalance: Record<string, string>
    }>('suix_getBalance', [address, '0x2::sui::SUI'])

    return {
      address,
      amount: result.totalBalance,
      symbol: 'SUI',
      decimals: 9,
    }
  }

  /**
   * Get transaction details by digest (hash).
   * Uses sui_getTransactionBlock.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const tx = await this.rpc.request<Record<string, unknown>>(
        'sui_getTransactionBlock',
        [
          hash,
          {
            showInput: true,
            showEffects: true,
            showBalanceChanges: true,
          },
        ],
      )

      if (!tx) return null

      const effects = tx.effects as Record<string, unknown> | undefined
      const txData = tx.transaction as Record<string, unknown> | undefined
      const data = txData?.data as Record<string, unknown> | undefined

      // Determine status
      const executionStatus = effects?.status as Record<string, string> | undefined
      let status: 'pending' | 'confirmed' | 'failed' = 'pending'
      if (executionStatus) {
        status = executionStatus.status === 'success' ? 'confirmed' : 'failed'
      }

      // Extract fee from gas used
      let fee = '0'
      const gasUsed = effects?.gasUsed as SuiFeeDetail | undefined
      if (gasUsed) {
        const computation = BigInt(gasUsed.computationCost || '0')
        const storage = BigInt(gasUsed.storageCost || '0')
        const rebate = BigInt(gasUsed.storageRebate || '0')
        fee = (computation + storage - rebate).toString()
      }

      // Extract sender
      const sender = (data?.sender as string) ?? ''

      // Get checkpoint/timestamp
      const checkpoint = tx.checkpoint as string | undefined
      const timestampMs = tx.timestampMs as string | undefined
      const timestamp = timestampMs ? Math.floor(Number(timestampMs) / 1000) : null

      return {
        hash: tx.digest as string,
        from: sender,
        to: null, // Sui transactions don't have a single "to" field
        value: '0', // Value is in balance changes, not a single field
        fee,
        blockNumber: checkpoint ? Number(checkpoint) : null,
        blockHash: null,
        status,
        timestamp,
        nonce: undefined,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get checkpoint (block equivalent) details by sequence number.
   * Uses sui_getCheckpoint.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      const sequenceNumber =
        typeof hashOrNumber === 'number' ? hashOrNumber.toString() : hashOrNumber

      const checkpoint = await this.rpc.request<Record<string, unknown>>(
        'sui_getCheckpoint',
        [sequenceNumber],
      )

      if (!checkpoint) return null

      const timestampMs = checkpoint.timestampMs as string | undefined
      const timestamp = timestampMs ? Math.floor(Number(timestampMs) / 1000) : 0

      return {
        number: Number(checkpoint.sequenceNumber),
        hash: checkpoint.digest as string,
        parentHash: checkpoint.previousDigest as string ?? '',
        timestamp,
        transactions: (checkpoint.transactions as string[]) ?? [],
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get the latest transaction sequence for a Sui address.
   * Returns the total transaction count for the address.
   */
  async getNonce(address: Address): Promise<number> {
    try {
      const result = await this.rpc.request<{ data: unknown[]; nextCursor?: string; hasNextPage: boolean }>(
        'suix_queryTransactionBlocks',
        [{ filter: { FromAddress: address } }, null, 1, true],
      )
      // Use the total count from recent transactions as a proxy
      return result.data.length
    } catch {
      return 0
    }
  }

  /**
   * Estimate transaction fees using sui_dryRunTransactionBlock.
   * Returns reference gas price based estimates.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Get the reference gas price for the current epoch
    const referenceGasPrice = await this.rpc.request<string>(
      'suix_getReferenceGasPrice',
      [],
    )

    const basePrice = BigInt(referenceGasPrice)

    // Convert from MIST to SUI for display (1 SUI = 10^9 MIST)
    const toSui = (mist: bigint) => {
      const sui = Number(mist) / 1e9
      return sui.toFixed(9)
    }

    // Estimate costs based on reference gas price
    // Typical computation budget ranges
    const slowBudget = basePrice * 1000n
    const averageBudget = basePrice * 2000n
    const fastBudget = basePrice * 5000n

    return {
      slow: toSui(slowBudget),
      average: toSui(averageBudget),
      fast: toSui(fastBudget),
      unit: 'SUI',
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   * Uses sui_executeTransactionBlock.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    // signedTx is expected to be a JSON string containing txBytes and signatures
    // or a serialized transaction with signature
    const result = await this.rpc.request<Record<string, unknown>>(
      'sui_executeTransactionBlock',
      [
        signedTx,
        [], // signatures array (expected to be embedded or passed separately)
        {
          showEffects: true,
        },
        'WaitForLocalExecution',
      ],
    )

    return result.digest as string
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [chainId, latestCheckpoint] = await Promise.all([
      this.rpc.request<string>('sui_getChainIdentifier', []).catch(() => 'unknown'),
      this.rpc.request<string>('sui_getLatestCheckpointSequenceNumber', []),
    ])

    const blockHeight = Number(latestCheckpoint)

    return {
      chainId,
      name: 'Sui',
      symbol: 'SUI',
      decimals: 9,
      testnet: false,
      blockHeight,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only Move function on a Sui package.
   * @param contractAddress - The package object ID
   * @param method - Module::function format (e.g., "module::function")
   * @param params - Function type arguments and parameters
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // For Sui, method format: "module::function"
    const [module, func] = method.includes('::')
      ? method.split('::')
      : ['', method]

    const typeArguments = (params?.[0] as string[]) ?? []
    const args = (params?.[1] as unknown[]) ?? []

    return this.rpc.request('sui_devInspectTransactionBlock', [
      contractAddress,
      {
        kind: 'moveCall',
        target: `${contractAddress}::${module}::${func}`,
        typeArguments,
        arguments: args,
      },
    ])
  }

  /**
   * Estimate gas for a transaction using dry run.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    const result = await this.rpc.request<Record<string, unknown>>(
      'sui_dryRunTransactionBlock',
      [method], // expects serialized transaction bytes
    )

    const effects = result.effects as Record<string, unknown> | undefined
    const gasUsed = effects?.gasUsed as SuiFeeDetail | undefined

    if (gasUsed) {
      const computation = BigInt(gasUsed.computationCost || '0')
      const storage = BigInt(gasUsed.storageCost || '0')
      const rebate = BigInt(gasUsed.storageRebate || '0')
      return (computation + storage - rebate).toString()
    }

    return '0'
  }

  // ------- TokenCapable -------

  /**
   * Get the balance of a specific coin type for an address.
   * @param address - The holder address
   * @param tokenAddress - The coin type (e.g., "0x2::sui::SUI" or custom coin type)
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    const result = await this.rpc.request<{
      coinType: string
      coinObjectCount: number
      totalBalance: string
    }>('suix_getBalance', [address, tokenAddress])

    // Extract symbol from coin type (last segment)
    const parts = tokenAddress.split('::')
    const symbol = parts.length > 0 ? parts[parts.length - 1] : 'UNKNOWN'

    return {
      address,
      amount: result.totalBalance,
      symbol,
      decimals: 9, // Default to 9 for Sui coins
    }
  }

  /**
   * Get metadata for a coin type.
   * @param tokenAddress - The coin type string
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const metadata = await this.rpc.request<Record<string, unknown>>(
      'suix_getCoinMetadata',
      [tokenAddress],
    )

    return {
      address: tokenAddress,
      name: (metadata?.name as string) ?? '',
      symbol: (metadata?.symbol as string) ?? '',
      decimals: (metadata?.decimals as number) ?? 9,
      totalSupply: undefined, // Sui coin metadata doesn't include total supply directly
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
   * Subscribe to new checkpoints via polling.
   * Polls every ~3 seconds (Sui produces checkpoints frequently).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastCheckpoint = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const latest = await this.rpc.request<string>(
            'sui_getLatestCheckpointSequenceNumber',
            [],
          )
          const checkpointNumber = Number(latest)

          if (checkpointNumber > lastCheckpoint) {
            lastCheckpoint = checkpointNumber
            callback(checkpointNumber)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 3000))
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
   * Polls every ~3 seconds and checks for new transactions.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastDigest: string | null = null
    let active = true

    const poll = async () => {
      while (active) {
        try {
          // Query transactions involving this address
          const result = await this.rpc.request<Record<string, unknown>>(
            'suix_queryTransactionBlocks',
            [
              {
                filter: { FromAddress: address },
                options: { showEffects: true, showInput: true },
              },
              null, // cursor
              1, // limit
              true, // descending
            ],
          )

          const data = result.data as Record<string, unknown>[] | undefined
          if (data && data.length > 0) {
            const latestDigest = data[0].digest as string
            if (lastDigest !== null && latestDigest !== lastDigest) {
              const txInfo = await this.getTransaction(latestDigest)
              if (txInfo) {
                callback(txInfo)
              }
            }
            lastDigest = latestDigest
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }
      }
    }

    // Initialize last digest
    try {
      const result = await this.rpc.request<Record<string, unknown>>(
        'suix_queryTransactionBlocks',
        [
          { filter: { FromAddress: address } },
          null,
          1,
          true,
        ],
      )
      const data = result.data as Record<string, unknown>[] | undefined
      if (data && data.length > 0) {
        lastDigest = data[0].digest as string
      }
    } catch {
      // Start from null
    }

    // Start polling in background
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
