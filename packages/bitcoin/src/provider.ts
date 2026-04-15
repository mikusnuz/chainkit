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
 * Bitcoin provider implementing ChainProvider, UtxoCapable,
 * and SubscriptionCapable interfaces.
 *
 * Uses JSON-RPC via an internal RpcManager to interact with Bitcoin nodes
 * (Bitcoin Core RPC or compatible APIs like Blockstream/Electrum).
 */
export class BitcoinProvider
  implements ChainProvider, UtxoCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the BTC balance of an address by summing all UTXOs.
   * Uses the `listunspent` RPC method (or scantxoutset for watch-only).
   */
  async getBalance(address: Address): Promise<Balance> {
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
    try {
      // getrawtransaction with verbose=true returns decoded tx
      const tx = await this.rpc.request<Record<string, unknown>>(
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
        const block = await this.rpc.request<Record<string, unknown>>(
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
    try {
      let blockHash: string

      if (typeof hashOrNumber === 'number') {
        // Get block hash by height
        blockHash = await this.rpc.request<string>('getblockhash', [hashOrNumber])
      } else {
        blockHash = hashOrNumber
      }

      const block = await this.rpc.request<Record<string, unknown>>('getblock', [blockHash])
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
   * Estimate transaction fees in sat/vByte.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Bitcoin Core's estimatesmartfee takes a confirmation target (number of blocks)
    const [slow, average, fast] = await Promise.all([
      this.rpc.request<Record<string, unknown>>('estimatesmartfee', [6]),
      this.rpc.request<Record<string, unknown>>('estimatesmartfee', [3]),
      this.rpc.request<Record<string, unknown>>('estimatesmartfee', [1]),
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
    return this.rpc.request<string>('sendrawtransaction', [rawHex])
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const info = await this.rpc.request<Record<string, unknown>>('getblockchaininfo', [])

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
    // Use scantxoutset which works for any address without importing
    const result = await this.rpc.request<Record<string, unknown>>('scantxoutset', [
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
          const info = await this.rpc.request<Record<string, unknown>>('getblockchaininfo', [])
          const blockNumber = info.blocks as number

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
          const info = await this.rpc.request<Record<string, unknown>>('getblockchaininfo', [])
          const currentBlock = info.blocks as number

          if (currentBlock > lastBlockNumber) {
            for (
              let blockNum = lastBlockNumber + 1;
              blockNum <= currentBlock && active;
              blockNum++
            ) {
              const blockHash = await this.rpc.request<string>('getblockhash', [blockNum])
              const block = await this.rpc.request<Record<string, unknown>>('getblock', [blockHash, 2])

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
      const info = await this.rpc.request<Record<string, unknown>>('getblockchaininfo', [])
      lastBlockNumber = info.blocks as number
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
