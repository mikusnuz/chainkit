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
 * Kaspa provider implementing ChainProvider, UtxoCapable,
 * and SubscriptionCapable interfaces.
 *
 * Communicates with a kaspad node via its REST/RPC API.
 * Kaspa operates on a blockDAG (not a blockchain), so "blocks" are actually
 * DAG blocks. Balance is UTXO-based.
 */
export class KaspaProvider
  implements ChainProvider, UtxoCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the KAS balance of an address by summing all UTXOs.
   */
  async getBalance(address: Address): Promise<Balance> {
    const utxos = await this.getUtxos(address)

    let totalSompi = 0n
    for (const utxo of utxos) {
      totalSompi += BigInt(utxo.amount)
    }

    return {
      address,
      amount: totalSompi.toString(),
      symbol: 'KAS',
      decimals: 8,
    }
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const tx = await this.rpc.request<Record<string, unknown>>(
        'getTransaction',
        [hash, true],
      )

      if (!tx) return null

      const txId = (tx.transactionId ?? tx.txid) as string
      const blockHash = (tx.blockHash ?? null) as string | null
      let blockNumber: number | null = null
      let timestamp: number | null = null
      let status: 'pending' | 'confirmed' | 'failed' = 'pending'

      if (blockHash) {
        status = 'confirmed'
        const block = await this.rpc.request<Record<string, unknown>>(
          'getBlock',
          [blockHash],
        )
        if (block) {
          const header = (block.header ?? block) as Record<string, unknown>
          blockNumber = (header.blueScore ?? header.daaScore ?? header.height ?? null) as number | null
          timestamp = header.timestamp as number ?? null
        }
      }

      // Parse outputs
      const outputs = (tx.outputs as Array<Record<string, unknown>>) ?? []
      let totalValue = 0n
      for (const output of outputs) {
        totalValue += BigInt((output.amount ?? output.value ?? '0') as string)
      }

      // Parse inputs
      const inputs = (tx.inputs as Array<Record<string, unknown>>) ?? []
      const fromAddress = inputs.length > 0
        ? ((inputs[0].previousOutpoint as Record<string, unknown>)?.address as string ?? 'unknown')
        : 'coinbase'
      const toAddress = outputs.length > 0
        ? ((outputs[0].scriptPublicKey as Record<string, unknown>)?.address as string ?? (outputs[0].address as string) ?? null)
        : null

      const fee = (tx.fee ?? '0') as string

      return {
        hash: txId,
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
        return null
      }
      throw err
    }
  }

  /**
   * Get block (DAG block) details by hash or DAA score.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      let blockHash: string

      if (typeof hashOrNumber === 'number') {
        // Get block by DAA score / blue score
        const result = await this.rpc.request<Record<string, unknown>>(
          'getBlockByDaaScore',
          [hashOrNumber],
        )
        blockHash = (result.hash ?? result.blockHash) as string
      } else {
        blockHash = hashOrNumber
      }

      const block = await this.rpc.request<Record<string, unknown>>(
        'getBlock',
        [blockHash],
      )
      if (!block) return null

      const header = (block.header ?? block) as Record<string, unknown>
      const parents = (header.parentHashes ?? header.parents ?? []) as string[]

      return {
        number: (header.blueScore ?? header.daaScore ?? header.height ?? 0) as number,
        hash: (block.hash ?? block.blockHash ?? blockHash) as string,
        parentHash: parents.length > 0 ? parents[0] : '0'.repeat(64),
        timestamp: (header.timestamp ?? 0) as number,
        transactions: ((block.transactions ?? block.tx ?? []) as Array<Record<string, unknown>>).map(
          (tx) => (tx.transactionId ?? tx.txid ?? '') as string,
        ),
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Estimate transaction fees.
   * Kaspa fees are based on transaction mass rather than gas.
   * Returns fee in sompi/gram (mass unit).
   */
  async estimateFee(): Promise<FeeEstimate> {
    try {
      const result = await this.rpc.request<Record<string, unknown>>(
        'getFeeEstimate',
        [],
      )

      const priorityBucket = result.priorityBucket as Record<string, unknown> | undefined
      const normalBuckets = (result.normalBuckets ?? []) as Array<Record<string, unknown>>

      const fast = (priorityBucket?.feerate ?? '1000') as string
      const average = normalBuckets.length > 0
        ? (normalBuckets[0].feerate ?? '500') as string
        : '500'
      const slow = normalBuckets.length > 1
        ? (normalBuckets[normalBuckets.length - 1].feerate ?? '100') as string
        : '100'

      return {
        slow,
        average,
        fast,
        unit: 'sompi/gram',
      }
    } catch {
      // Fallback defaults if fee estimation is not available
      return {
        slow: '100',
        average: '500',
        fast: '1000',
        unit: 'sompi/gram',
      }
    }
  }

  /**
   * Broadcast a signed transaction to the Kaspa network.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const rawHex = signedTx.startsWith('0x') ? signedTx.slice(2) : signedTx
    return this.rpc.request<string>('submitTransaction', [rawHex])
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const info = await this.rpc.request<Record<string, unknown>>(
      'getBlockDagInfo',
      [],
    )

    const networkName = (info.networkName ?? info.network ?? 'kaspa-mainnet') as string
    const isTestnet = networkName.includes('testnet') || networkName.includes('devnet') || networkName.includes('simnet')
    const virtualDaaScore = (info.virtualDaaScore ?? info.tipCount ?? 0) as number

    let name: string
    if (networkName.includes('testnet')) {
      name = 'Kaspa Testnet'
    } else if (networkName.includes('devnet')) {
      name = 'Kaspa Devnet'
    } else if (networkName.includes('simnet')) {
      name = 'Kaspa Simnet'
    } else {
      name = 'Kaspa Mainnet'
    }

    return {
      chainId: networkName,
      name,
      symbol: 'KAS',
      decimals: 8,
      testnet: isTestnet,
      blockHeight: virtualDaaScore,
    }
  }

  // ------- UtxoCapable -------

  /**
   * Get unspent transaction outputs for an address.
   */
  async getUtxos(address: Address): Promise<Utxo[]> {
    const result = await this.rpc.request<Array<Record<string, unknown>>>(
      'getUtxosByAddress',
      [address],
    )

    const entries = result ?? []

    return entries.map((entry) => {
      const outpoint = (entry.outpoint ?? {}) as Record<string, unknown>
      const utxoEntry = (entry.utxoEntry ?? entry) as Record<string, unknown>

      return {
        txHash: (outpoint.transactionId ?? outpoint.txid ?? entry.txid ?? '') as string,
        outputIndex: (outpoint.index ?? outpoint.vout ?? entry.vout ?? 0) as number,
        amount: (utxoEntry.amount ?? utxoEntry.value ?? '0').toString(),
        script: ((utxoEntry.scriptPublicKey as Record<string, unknown>)?.script ?? utxoEntry.scriptPubKey ?? '') as string,
        confirmed: (utxoEntry.blockDaaScore ?? utxoEntry.height ?? 0) as number > 0,
      }
    })
  }

  /**
   * Select UTXOs for a target amount using a greedy largest-first selection.
   */
  async selectUtxos(
    address: Address,
    targetAmount: string,
  ): Promise<{ utxos: Utxo[]; change: string }> {
    const allUtxos = await this.getUtxos(address)

    // Sort by amount descending
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
        `Insufficient funds: have ${accumulated.toString()} sompi, need ${target.toString()}`,
      )
    }

    return {
      utxos: selected,
      change: (accumulated - target).toString(),
    }
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new DAG blocks via polling.
   * Kaspa produces blocks approximately every second (1 BPS).
   * Uses a 5-second poll interval.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastDaaScore = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const info = await this.rpc.request<Record<string, unknown>>(
            'getBlockDagInfo',
            [],
          )
          const daaScore = (info.virtualDaaScore ?? info.tipCount ?? 0) as number

          if (daaScore > lastDaaScore) {
            lastDaaScore = daaScore
            callback(daaScore)
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
   * Checks for new UTXOs every 5 seconds.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let knownTxHashes = new Set<string>()
    let active = true

    // Initialize with current UTXOs
    try {
      const utxos = await this.getUtxos(address)
      for (const utxo of utxos) {
        knownTxHashes.add(utxo.txHash)
      }
    } catch {
      // Start with empty set
    }

    const poll = async () => {
      while (active) {
        try {
          const utxos = await this.getUtxos(address)

          for (const utxo of utxos) {
            if (!knownTxHashes.has(utxo.txHash)) {
              knownTxHashes.add(utxo.txHash)
              const txInfo = await this.getTransaction(utxo.txHash)
              if (txInfo) {
                callback(txInfo)
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
