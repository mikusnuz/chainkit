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
 * Parse a hex string to a BigInt.
 */
function hexToBigInt(hex: string): bigint {
  if (!hex || hex === '0x' || hex === '0x0') return 0n
  return BigInt(hex)
}

/**
 * Parse a hex string to a number.
 */
function hexToNumber(hex: string): number {
  if (!hex || hex === '0x' || hex === '0x0') return 0
  return Number(BigInt(hex))
}

/**
 * ICON provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses ICON JSON-RPC v3 API to interact with the ICON blockchain.
 */
export class IconProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the ICX balance of an address.
   * Uses icx_getBalance RPC method.
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.rpc.request<string>('icx_getBalance', { address } as unknown as unknown[])
    const loop = hexToBigInt(result)

    return {
      address,
      amount: loop.toString(),
      symbol: 'ICX',
      decimals: 18,
    }
  }

  /**
   * Get transaction details by hash.
   * Uses icx_getTransactionResult for confirmed transactions.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const result = await this.rpc.request<Record<string, unknown>>(
        'icx_getTransactionResult',
        { txHash: hash } as unknown as unknown[],
      )

      if (!result) return null

      const status = result.status === '0x1' ? 'confirmed' as const : 'failed' as const
      const stepUsed = hexToBigInt(result.stepUsed as string ?? '0x0')
      const stepPrice = hexToBigInt(result.stepPrice as string ?? '0x0')
      const fee = (stepUsed * stepPrice).toString()

      // Get block timestamp
      let timestamp: number | null = null
      if (result.blockHeight) {
        try {
          const block = await this.rpc.request<Record<string, unknown>>(
            'icx_getBlockByHeight',
            { height: result.blockHeight } as unknown as unknown[],
          )
          if (block && block.time_stamp) {
            // ICON timestamp is in microseconds
            timestamp = Math.floor(Number(block.time_stamp) / 1_000_000)
          }
        } catch {
          // Ignore block fetch failures
        }
      }

      return {
        hash: hash,
        from: result.from as string ?? '',
        to: result.to as string ?? null,
        value: hexToBigInt(result.value as string ?? '0x0').toString(),
        fee,
        blockNumber: result.blockHeight ? hexToNumber(result.blockHeight as string) : null,
        blockHash: result.blockHash as string ?? null,
        status,
        timestamp,
        data: result.data ? JSON.stringify(result.data) : undefined,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        // Transaction not found or pending
        return null
      }
      throw err
    }
  }

  /**
   * Get block details by height.
   * Uses icx_getBlockByHeight RPC method.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      let block: Record<string, unknown> | null

      if (typeof hashOrNumber === 'number') {
        const height = '0x' + hashOrNumber.toString(16)
        block = await this.rpc.request<Record<string, unknown>>(
          'icx_getBlockByHeight',
          { height } as unknown as unknown[],
        )
      } else if (hashOrNumber.startsWith('0x') && hashOrNumber.length === 66) {
        // Block hash
        block = await this.rpc.request<Record<string, unknown>>(
          'icx_getBlockByHash',
          { hash: hashOrNumber } as unknown as unknown[],
        )
      } else {
        // Assume hex block height
        block = await this.rpc.request<Record<string, unknown>>(
          'icx_getBlockByHeight',
          { height: hashOrNumber } as unknown as unknown[],
        )
      }

      if (!block) return null

      // Extract transaction hashes
      const txs: string[] = []
      if (Array.isArray(block.confirmed_transaction_list)) {
        for (const tx of block.confirmed_transaction_list as Record<string, string>[]) {
          if (tx.txHash) txs.push(tx.txHash)
        }
      }

      return {
        number: typeof block.height === 'number' ? block.height : hexToNumber(block.height as string),
        hash: block.block_hash as string ?? '',
        parentHash: block.prev_block_hash as string ?? '',
        timestamp: block.time_stamp
          ? Math.floor(Number(block.time_stamp) / 1_000_000)
          : 0,
        transactions: txs,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get the transaction count (nonce) for an address.
   * Uses icx_getTransactionCount to retrieve the count.
   */
  async getNonce(address: Address): Promise<number> {
    try {
      const result = await this.rpc.request<string>(
        'icx_getTransactionCount',
        { address, tag: 'latest' } as unknown as unknown[],
      )
      return hexToNumber(result)
    } catch {
      return 0
    }
  }

  /**
   * Estimate transaction fees.
   * ICON uses step (gas) with a step price. Returns in ICX.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // ICON step price is fixed per governance decision
    // Default step price is 12500000000 (12.5 Gloop = 0.0000000125 ICX)
    // Default transfer step: 100000
    // SCORE call step: ~200000-500000

    try {
      // Try to get governance step price
      const stepPriceHex = await this.callContract(
        'cx0000000000000000000000000000000000000001', // governance SCORE
        'getStepPrice',
      ) as string
      const stepPrice = hexToBigInt(stepPriceHex)

      // Calculate fees based on common step limits
      const transferStep = 100000n
      const scoreCallStep = 300000n
      const complexStep = 1000000n

      const slow = (transferStep * stepPrice)
      const average = (scoreCallStep * stepPrice)
      const fast = (complexStep * stepPrice)

      // Convert from loop to ICX (1 ICX = 10^18 loop)
      const toIcx = (loop: bigint) => {
        const icx = Number(loop) / 1e18
        return icx.toFixed(6)
      }

      return {
        slow: toIcx(slow),
        average: toIcx(average),
        fast: toIcx(fast),
        unit: 'ICX',
      }
    } catch {
      // Fallback with default step price
      return {
        slow: '0.001250',
        average: '0.003750',
        fast: '0.012500',
        unit: 'ICX',
      }
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   * The signedTx is a hex-encoded JSON string of the signed transaction.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    // Decode the hex-encoded JSON transaction
    const hexStr = signedTx.startsWith('0x') ? signedTx.slice(2) : signedTx
    const bytes = new Uint8Array(hexStr.length / 2)
    for (let i = 0; i < hexStr.length; i += 2) {
      bytes[i / 2] = parseInt(hexStr.slice(i, i + 2), 16)
    }
    const jsonStr = new TextDecoder().decode(bytes)
    const txParams = JSON.parse(jsonStr)

    return this.rpc.request<string>(
      'icx_sendTransaction',
      txParams as unknown as unknown[],
    )
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    // ICON doesn't have a direct chain info endpoint, so we get the latest block
    try {
      const lastBlock = await this.rpc.request<Record<string, unknown>>(
        'icx_getLastBlock',
        [] as unknown[],
      )

      const blockHeight = typeof lastBlock.height === 'number'
        ? lastBlock.height
        : hexToNumber(lastBlock.height as string)

      // Try to determine network by NID
      let name = 'ICON'
      let testnet = false
      const nid = lastBlock.nid as string | undefined

      if (nid) {
        const nidNum = hexToNumber(nid)
        if (nidNum === 1) {
          name = 'ICON Mainnet'
        } else if (nidNum === 2) {
          name = 'ICON Lisbon Testnet'
          testnet = true
        } else if (nidNum === 3) {
          name = 'ICON Berlin Testnet'
          testnet = true
        } else if (nidNum === 7) {
          name = 'ICON Sejong Testnet'
          testnet = true
        }
      }

      return {
        chainId: nid ?? '0x1',
        name,
        symbol: 'ICX',
        decimals: 18,
        testnet,
        blockHeight,
      }
    } catch {
      return {
        chainId: '0x1',
        name: 'ICON',
        symbol: 'ICX',
        decimals: 18,
        testnet: false,
      }
    }
  }

  // ------- ContractCapable (SCORE) -------

  /**
   * Call a read-only SCORE method.
   * @param contractAddress - SCORE address (cx-prefixed)
   * @param method - Method name
   * @param params - Method parameters as key-value pairs
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    const callData: Record<string, unknown> = {
      to: contractAddress,
      dataType: 'call',
      data: {
        method,
      },
    }

    // ICON SCORE params are passed as a named object, not an array
    if (params && params.length > 0) {
      // If the first param is already an object (Record<string, string>), use it directly
      if (typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) {
        (callData.data as Record<string, unknown>).params = params[0]
      } else {
        // For simple cases, wrap in a params object
        (callData.data as Record<string, unknown>).params = params[0]
      }
    }

    return this.rpc.request<unknown>(
      'icx_call',
      callData as unknown as unknown[],
    )
  }

  /**
   * Estimate step (gas) for a SCORE call.
   * Uses debug_estimateStep if available, otherwise returns a default.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    try {
      const callData: Record<string, unknown> = {
        version: '0x3',
        from: 'hx0000000000000000000000000000000000000000',
        to: contractAddress,
        dataType: 'call',
        data: {
          method,
        },
      }

      if (params && params.length > 0) {
        if (typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) {
          (callData.data as Record<string, unknown>).params = params[0]
        }
      }

      const result = await this.rpc.request<string>(
        'debug_estimateStep',
        callData as unknown as unknown[],
      )
      return hexToBigInt(result).toString()
    } catch {
      // debug_estimateStep may not be available on all nodes
      // Return a reasonable default for SCORE calls
      return '300000'
    }
  }

  // ------- TokenCapable (IRC-2) -------

  /**
   * Get the IRC-2 token balance for an address.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    const [balanceHex, decimalsResult, symbolResult] = await Promise.all([
      this.callContract(tokenAddress, 'balanceOf', [{ _owner: address }]) as Promise<string>,
      this.callContract(tokenAddress, 'decimals') as Promise<string>,
      this.callContract(tokenAddress, 'symbol') as Promise<string>,
    ])

    const balance = hexToBigInt(balanceHex)
    const decimals = hexToNumber(decimalsResult)

    return {
      address,
      amount: balance.toString(),
      symbol: symbolResult,
      decimals,
    }
  }

  /**
   * Get metadata for an IRC-2 token.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const [nameResult, symbolResult, decimalsResult, totalSupplyResult] = await Promise.all([
      this.callContract(tokenAddress, 'name') as Promise<string>,
      this.callContract(tokenAddress, 'symbol') as Promise<string>,
      this.callContract(tokenAddress, 'decimals') as Promise<string>,
      this.callContract(tokenAddress, 'totalSupply') as Promise<string>,
    ])

    return {
      address: tokenAddress,
      name: nameResult,
      symbol: symbolResult,
      decimals: hexToNumber(decimalsResult),
      totalSupply: hexToBigInt(totalSupplyResult).toString(),
    }
  }

  /**
   * Get balances for multiple IRC-2 tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * ICON has ~2 second block time.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const lastBlock = await this.rpc.request<Record<string, unknown>>(
            'icx_getLastBlock',
            [] as unknown[],
          )
          const blockNumber = typeof lastBlock.height === 'number'
            ? lastBlock.height
            : hexToNumber(lastBlock.height as string)

          if (blockNumber > lastBlockNumber) {
            lastBlockNumber = blockNumber
            callback(blockNumber)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
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
   * Checks new blocks for matching transactions.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true
    const normalizedAddress = address.toLowerCase()

    const poll = async () => {
      while (active) {
        try {
          const lastBlock = await this.rpc.request<Record<string, unknown>>(
            'icx_getLastBlock',
            [] as unknown[],
          )
          const currentBlock = typeof lastBlock.height === 'number'
            ? lastBlock.height
            : hexToNumber(lastBlock.height as string)

          if (currentBlock > lastBlockNumber) {
            for (
              let blockNum = lastBlockNumber + 1;
              blockNum <= currentBlock && active;
              blockNum++
            ) {
              const block = await this.rpc.request<Record<string, unknown>>(
                'icx_getBlockByHeight',
                { height: '0x' + blockNum.toString(16) } as unknown as unknown[],
              )

              if (block && Array.isArray(block.confirmed_transaction_list)) {
                for (const tx of block.confirmed_transaction_list as Record<string, string>[]) {
                  if (
                    tx.from?.toLowerCase() === normalizedAddress ||
                    tx.to?.toLowerCase() === normalizedAddress
                  ) {
                    const txInfo = await this.getTransaction(tx.txHash)
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
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    }

    // Initialize lastBlockNumber
    try {
      const lastBlock = await this.rpc.request<Record<string, unknown>>(
        'icx_getLastBlock',
        [] as unknown[],
      )
      lastBlockNumber = typeof lastBlock.height === 'number'
        ? lastBlock.height
        : hexToNumber(lastBlock.height as string)
    } catch {
      // Start from 0
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
