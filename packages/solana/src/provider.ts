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
 * Solana provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses Solana JSON-RPC via an internal RpcManager.
 */
export class SolanaProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the SOL balance of an address.
   * Uses the `getBalance` RPC method.
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.rpc.request<{ value: number }>('getBalance', [
      address,
      { commitment: 'confirmed' },
    ])

    return {
      address,
      amount: result.value.toString(),
      symbol: 'SOL',
      decimals: 9,
    }
  }

  /**
   * Get transaction details by signature hash.
   * Uses the `getTransaction` RPC method.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    const tx = await this.rpc.request<Record<string, unknown> | null>('getTransaction', [
      hash,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ])

    if (!tx) return null

    const meta = tx.meta as Record<string, unknown> | null
    const transaction = tx.transaction as Record<string, unknown>
    const message = transaction.message as Record<string, unknown>
    const accountKeys = message.accountKeys as Array<Record<string, string> | string>

    // Determine from/to addresses
    const from = typeof accountKeys[0] === 'string' ? accountKeys[0] : accountKeys[0].pubkey
    const to = accountKeys.length > 1
      ? (typeof accountKeys[1] === 'string' ? accountKeys[1] : accountKeys[1].pubkey)
      : null

    // Determine status
    const err = meta?.err
    let status: 'pending' | 'confirmed' | 'failed' = 'confirmed'
    if (err !== null && err !== undefined) {
      status = 'failed'
    }

    // Calculate fee
    const fee = meta?.fee != null ? String(meta.fee) : '0'

    // Calculate value from balance changes
    let value = '0'
    if (meta) {
      const preBalances = meta.preBalances as number[] | undefined
      const postBalances = meta.postBalances as number[] | undefined
      if (preBalances && postBalances && postBalances.length > 1) {
        // Value transferred to the second account
        const received = postBalances[1] - preBalances[1]
        value = Math.max(0, received).toString()
      }
    }

    const blockTime = tx.blockTime as number | null
    const slot = tx.slot as number

    return {
      hash,
      from,
      to,
      value,
      fee,
      blockNumber: slot,
      blockHash: null,
      status,
      timestamp: blockTime ?? null,
      nonce: 0,
    }
  }

  /**
   * Get block details by slot number.
   * Uses the `getBlock` RPC method.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    const slot = typeof hashOrNumber === 'number' ? hashOrNumber : parseInt(hashOrNumber, 10)

    if (isNaN(slot)) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        `Invalid slot number: ${hashOrNumber}. Solana uses slot numbers, not block hashes.`,
      )
    }

    try {
      const block = await this.rpc.request<Record<string, unknown> | null>('getBlock', [
        slot,
        {
          encoding: 'jsonParsed',
          transactionDetails: 'signatures',
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ])

      if (!block) return null

      const signatures = (block.signatures as string[]) ?? []
      const blockTime = block.blockTime as number | null
      const blockhash = block.blockhash as string
      const previousBlockhash = block.previousBlockhash as string

      return {
        number: slot,
        hash: blockhash,
        parentHash: previousBlockhash,
        timestamp: blockTime ?? 0,
        transactions: signatures,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        // Slot may be skipped
        return null
      }
      throw err
    }
  }

  /**
   * Get the latest blockhash (Solana does not use a traditional nonce).
   * Returns the latest blockhash which is needed for transaction construction.
   */
  async getNonce(address: Address): Promise<string> {
    const result = await this.rpc.request<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'finalized' }])
    return result.value.blockhash
  }

  /**
   * Estimate transaction fees on Solana.
   * Uses `getRecentPrioritizationFees` to estimate priority fees.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Solana base fee is 5000 lamports per signature
    const baseFee = 5000

    try {
      const fees = await this.rpc.request<Array<{ prioritizationFee: number; slot: number }>>(
        'getRecentPrioritizationFees',
        [],
      )

      if (fees && fees.length > 0) {
        const priorityFees = fees
          .map((f) => f.prioritizationFee)
          .filter((f) => f > 0)
          .sort((a, b) => a - b)

        if (priorityFees.length > 0) {
          const slow = baseFee + priorityFees[0]
          const medianIndex = Math.floor(priorityFees.length / 2)
          const average = baseFee + priorityFees[medianIndex]
          const fast = baseFee + priorityFees[priorityFees.length - 1]

          return {
            slow: slow.toString(),
            average: average.toString(),
            fast: fast.toString(),
            unit: 'lamports',
          }
        }
      }
    } catch {
      // Fall through to defaults
    }

    // Default: just base fee
    return {
      slow: baseFee.toString(),
      average: baseFee.toString(),
      fast: (baseFee * 2).toString(),
      unit: 'lamports',
    }
  }

  /**
   * Broadcast a signed transaction to the Solana network.
   * Expects base64-encoded signed transaction.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    // Solana sendTransaction expects base64-encoded transaction
    return this.rpc.request<string>('sendTransaction', [
      signedTx,
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ])
  }

  /**
   * Get Solana chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [version, slot, genesisHash] = await Promise.all([
      this.rpc.request<{ 'solana-core': string; 'feature-set': number }>('getVersion', []),
      this.rpc.request<number>('getSlot', [{ commitment: 'confirmed' }]),
      this.rpc.request<string>('getGenesisHash', []),
    ])

    // Determine network from genesis hash
    const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
    const TESTNET_GENESIS = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'
    const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

    let name = 'Solana'
    let testnet = false

    if (genesisHash === MAINNET_GENESIS) {
      name = 'Solana Mainnet'
    } else if (genesisHash === TESTNET_GENESIS) {
      name = 'Solana Testnet'
      testnet = true
    } else if (genesisHash === DEVNET_GENESIS) {
      name = 'Solana Devnet'
      testnet = true
    } else {
      name = 'Solana (Unknown Network)'
      testnet = true
    }

    return {
      chainId: genesisHash,
      name,
      symbol: 'SOL',
      decimals: 9,
      testnet,
      blockHeight: slot,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only program method via simulateTransaction.
   * For Solana, this simulates a transaction to read program state.
   * @param contractAddress - The program ID
   * @param method - Base64-encoded transaction to simulate
   * @param params - Optional parameters (unused for simulation)
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // For Solana, simulate a transaction
    const result = await this.rpc.request<Record<string, unknown>>('simulateTransaction', [
      method,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        sigVerify: false,
      },
    ])

    const value = result.value as Record<string, unknown>
    if (value.err) {
      throw new ChainKitError(
        ErrorCode.TRANSACTION_FAILED,
        `Simulation failed: ${JSON.stringify(value.err)}`,
        { programId: contractAddress, error: value.err },
      )
    }

    return value
  }

  /**
   * Estimate compute units for a transaction.
   * Uses simulateTransaction to get compute units consumed.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    const result = await this.rpc.request<Record<string, unknown>>('simulateTransaction', [
      method,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        sigVerify: false,
      },
    ])

    const value = result.value as Record<string, unknown>
    const unitsConsumed = value.unitsConsumed as number | undefined

    return (unitsConsumed ?? 200000).toString()
  }

  // ------- TokenCapable -------

  /**
   * Get the SPL token balance for an address.
   * @param address - The holder address
   * @param tokenAddress - The token mint address
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    const result = await this.rpc.request<{
      value: Array<{
        pubkey: string
        account: {
          data: {
            parsed: {
              info: {
                tokenAmount: {
                  amount: string
                  decimals: number
                  uiAmountString: string
                }
                mint: string
              }
            }
          }
        }
      }>
    }>('getTokenAccountsByOwner', [
      address,
      { mint: tokenAddress },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ])

    if (!result.value || result.value.length === 0) {
      return {
        address,
        amount: '0',
        symbol: '',
        decimals: 0,
      }
    }

    const tokenAccount = result.value[0]
    const info = tokenAccount.account.data.parsed.info
    const tokenAmount = info.tokenAmount

    return {
      address,
      amount: tokenAmount.amount,
      symbol: '',
      decimals: tokenAmount.decimals,
    }
  }

  /**
   * Get metadata for an SPL token.
   * @param tokenAddress - The token mint address
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    // Get mint account info for basic metadata
    const result = await this.rpc.request<{
      value: {
        data: {
          parsed: {
            info: {
              decimals: number
              supply: string
              mintAuthority: string | null
            }
          }
        }
      } | null
    }>('getAccountInfo', [
      tokenAddress,
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ])

    if (!result.value) {
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        `Token mint not found: ${tokenAddress}`,
      )
    }

    const info = result.value.data.parsed.info

    return {
      address: tokenAddress,
      name: '',
      symbol: '',
      decimals: info.decimals,
      totalSupply: info.supply,
    }
  }

  /**
   * Get balances for multiple SPL tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new slots (Solana's equivalent of blocks) via polling.
   * Polls every ~400ms (Solana slot time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastSlot = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const slot = await this.rpc.request<number>('getSlot', [
            { commitment: 'confirmed' },
          ])

          if (slot > lastSlot) {
            lastSlot = slot
            callback(slot)
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
   * Subscribe to transactions for an address via polling.
   * Polls for new signatures and fetches transaction details.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastSignature: string | null = null
    let active = true

    // Get the most recent signature to start from
    try {
      const signatures = await this.rpc.request<Array<{ signature: string }>>(
        'getSignaturesForAddress',
        [address, { limit: 1, commitment: 'confirmed' }],
      )
      if (signatures && signatures.length > 0) {
        lastSignature = signatures[0].signature
      }
    } catch {
      // Start from scratch
    }

    const poll = async () => {
      while (active) {
        try {
          const params: [string, Record<string, unknown>] = [
            address,
            { commitment: 'confirmed', limit: 10 },
          ]
          if (lastSignature) {
            params[1].until = lastSignature
          }

          const signatures = await this.rpc.request<
            Array<{ signature: string; slot: number; err: unknown | null }>
          >('getSignaturesForAddress', params)

          if (signatures && signatures.length > 0) {
            // Process in chronological order (oldest first)
            for (let i = signatures.length - 1; i >= 0 && active; i--) {
              const sig = signatures[i]
              const txInfo = await this.getTransaction(sig.signature)
              if (txInfo) {
                callback(txInfo)
              }
            }
            lastSignature = signatures[0].signature
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
