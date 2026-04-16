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
 * Configuration for the Algorand provider.
 */
export interface AlgorandProviderConfig {
  /** Algod REST API base URL (e.g., "https://testnet-api.algonode.cloud") */
  baseUrl: string
  /** Optional API token for authenticated endpoints */
  apiToken?: string
}

/**
 * Helper to make Algod REST API requests.
 */
async function algodRequest<T>(
  config: AlgorandProviderConfig,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const url = `${config.baseUrl}${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (config.apiToken) {
    headers['X-Algo-API-Token'] = config.apiToken
  }

  const fetchOptions: RequestInit = {
    method: options?.method ?? 'GET',
    headers,
  }
  if (options?.body) {
    fetchOptions.body = JSON.stringify(options.body)
  }

  const response = await fetch(url, fetchOptions)

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error')
    throw new ChainKitError(
      ErrorCode.RPC_ERROR,
      `Algod API error (${response.status}): ${errorBody}`,
    )
  }

  return response.json() as Promise<T>
}

/**
 * Algorand provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses the Algod REST API.
 */
export class AlgorandProvider

  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly config: AlgorandProviderConfig

  constructor(config: AlgorandProviderConfig) {
    this.config = config
  }

  // ------- ChainProvider -------

  /**
   * Get the ALGO balance of an address.
   * Uses GET /v2/accounts/{address}
   */
  async getBalance(address: Address): Promise<Balance> {
    const account = await algodRequest<{
      amount: number
      'min-balance': number
      status: string
    }>(this.config, `/v2/accounts/${address}`)

    return {
      address,
      amount: account.amount.toString(),
      symbol: 'ALGO',
      decimals: 6,
    }
  }

  /**
   * Get transaction details by ID.
   * Uses GET /v2/transactions/pending/{txid} for pending,
   * or the indexer pattern via /v2/transactions/{txid}.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      // Try pending transactions first
      const tx = await algodRequest<{
        'pool-error': string
        txn: {
          txn: {
            type: string
            snd: string
            rcv?: string
            amt?: number
            fee: number
            fv: number
            lv: number
            gh: string
            gen?: string
            note?: string
          }
        }
        'confirmed-round'?: number
        'application-index'?: number
      }>(this.config, `/v2/transactions/pending/${hash}`)

      const inner = tx.txn.txn
      const status: 'pending' | 'confirmed' | 'failed' = tx['confirmed-round']
        ? 'confirmed'
        : tx['pool-error']
          ? 'failed'
          : 'pending'

      return {
        hash,
        from: inner.snd ?? '',
        to: inner.rcv ?? null,
        value: (inner.amt ?? 0).toString(),
        fee: inner.fee.toString(),
        blockNumber: tx['confirmed-round'] ?? null,
        blockHash: null,
        status,
        timestamp: null,
        nonce: inner.fv,
      }
    } catch {
      return null
    }
  }

  /**
   * Get block details by round number.
   * Uses GET /v2/blocks/{round}
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    const round = typeof hashOrNumber === 'number' ? hashOrNumber : parseInt(hashOrNumber, 10)

    if (isNaN(round)) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        `Invalid round number: ${hashOrNumber}. Algorand uses round numbers.`,
      )
    }

    try {
      const block = await algodRequest<{
        block: {
          rnd: number
          gh: string
          prev: string
          ts: number
          txns?: Array<{ txn: { txn: { type: string } }; txID?: string }>
        }
      }>(this.config, `/v2/blocks/${round}`)

      const txIds = (block.block.txns ?? [])
        .map((t) => t.txID ?? '')
        .filter((id) => id !== '')

      return {
        number: block.block.rnd,
        hash: block.block.gh,
        parentHash: block.block.prev,
        timestamp: block.block.ts,
        transactions: txIds,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get the next valid round for an Algorand address (used as nonce equivalent).
   * Returns the account's minimum balance round or the current round.
   */
  async getNonce(address: Address): Promise<number> {
    try {
      const account = await algodRequest<{ round: number }>(
        this.config,
        `/v2/accounts/${address}`,
      )
      return account.round ?? 0
    } catch {
      return 0
    }
  }

  /**
   * Estimate transaction fees on Algorand.
   * Uses GET /v2/transactions/params to get suggested fee.
   */
  async estimateFee(): Promise<FeeEstimate> {
    const params = await algodRequest<{
      fee: number
      'min-fee': number
      'last-round': number
      'genesis-hash': string
      'genesis-id': string
      'consensus-version': string
    }>(this.config, '/v2/transactions/params')

    const minFee = params['min-fee']
    const suggestedFee = params.fee > 0 ? params.fee : minFee

    return {
      slow: minFee.toString(),
      average: suggestedFee.toString(),
      fast: (suggestedFee * 2).toString(),
      unit: 'microAlgo',
    }
  }

  /**
   * Broadcast a signed transaction to the Algorand network.
   * Uses POST /v2/transactions with raw transaction bytes.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const url = `${this.config.baseUrl}/v2/transactions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-binary',
    }
    if (this.config.apiToken) {
      headers['X-Algo-API-Token'] = this.config.apiToken
    }

    // signedTx is expected as hex-encoded raw transaction bytes
    const txBytes = hexToUint8Array(signedTx)

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: txBytes,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error')
      throw new ChainKitError(
        ErrorCode.TRANSACTION_FAILED,
        `Failed to broadcast transaction: ${errorBody}`,
      )
    }

    const result = await response.json() as { txId: string }
    return result.txId
  }

  /**
   * Get Algorand chain/network information.
   * Uses GET /v2/transactions/params and GET /v2/status
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [params, status] = await Promise.all([
      algodRequest<{
        'genesis-id': string
        'genesis-hash': string
        'last-round': number
      }>(this.config, '/v2/transactions/params'),
      algodRequest<{
        'last-round': number
        'last-version': string
      }>(this.config, '/v2/status'),
    ])

    const genesisId = params['genesis-id']

    // Determine network from genesis-id
    let name = 'Algorand'
    let testnet = false

    if (genesisId === 'mainnet-v1.0') {
      name = 'Algorand Mainnet'
    } else if (genesisId === 'testnet-v1.0') {
      name = 'Algorand Testnet'
      testnet = true
    } else if (genesisId === 'betanet-v1.0') {
      name = 'Algorand Betanet'
      testnet = true
    } else {
      name = `Algorand (${genesisId})`
      testnet = true
    }

    return {
      chainId: params['genesis-hash'],
      name,
      symbol: 'ALGO',
      decimals: 6,
      testnet,
      blockHeight: status['last-round'],
    }
  }

  // ------- ContractCapable (ABI) -------

  /**
   * Call a read-only application method via dry-run.
   * @param contractAddress - The application ID (as string)
   * @param method - ABI method selector or encoded call data (hex)
   * @param params - Optional parameters
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // Use the dryrun endpoint to simulate application calls
    const result = await algodRequest<Record<string, unknown>>(
      this.config,
      '/v2/teal/dryrun',
      {
        method: 'POST',
        body: {
          txns: [
            {
              txn: {
                type: 'appl',
                apid: parseInt(contractAddress, 10),
                apaa: params ?? [],
              },
            },
          ],
        },
      },
    )

    return result
  }

  /**
   * Estimate gas (fee) for a contract call.
   * Returns the minimum fee since Algorand has flat fees.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    const feeParams = await algodRequest<{
      'min-fee': number
      fee: number
    }>(this.config, '/v2/transactions/params')

    // Application calls may need higher fee for inner transactions
    const baseFee = Math.max(feeParams['min-fee'], feeParams.fee)
    return baseFee.toString()
  }

  // ------- TokenCapable (ASA) -------

  /**
   * Get the ASA (Algorand Standard Asset) balance for an address.
   * @param address - The holder address
   * @param tokenAddress - The ASA ID (as string)
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    const account = await algodRequest<{
      assets?: Array<{
        'asset-id': number
        amount: number
        'is-frozen': boolean
      }>
    }>(this.config, `/v2/accounts/${address}`)

    const assetId = parseInt(tokenAddress, 10)
    const asset = (account.assets ?? []).find((a) => a['asset-id'] === assetId)

    if (!asset) {
      return {
        address,
        amount: '0',
        symbol: '',
        decimals: 0,
      }
    }

    // Need to fetch asset info for decimals
    try {
      const assetInfo = await algodRequest<{
        params: {
          decimals: number
          'unit-name'?: string
          name?: string
          total: number
        }
      }>(this.config, `/v2/assets/${tokenAddress}`)

      return {
        address,
        amount: asset.amount.toString(),
        symbol: assetInfo.params['unit-name'] ?? '',
        decimals: assetInfo.params.decimals,
      }
    } catch {
      return {
        address,
        amount: asset.amount.toString(),
        symbol: '',
        decimals: 0,
      }
    }
  }

  /**
   * Get metadata for an ASA (Algorand Standard Asset).
   * @param tokenAddress - The ASA ID (as string)
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const assetInfo = await algodRequest<{
      params: {
        decimals: number
        'unit-name'?: string
        name?: string
        total: number
        creator: string
      }
    }>(this.config, `/v2/assets/${tokenAddress}`)

    if (!assetInfo || !assetInfo.params) {
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        `Asset not found: ${tokenAddress}`,
      )
    }

    return {
      address: tokenAddress,
      name: assetInfo.params.name ?? '',
      symbol: assetInfo.params['unit-name'] ?? '',
      decimals: assetInfo.params.decimals,
      totalSupply: assetInfo.params.total.toString(),
    }
  }

  /**
   * Get balances for multiple ASA tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new rounds (blocks) via polling.
   * Polls every ~3.5 seconds (Algorand block time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastRound = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const status = await algodRequest<{
            'last-round': number
          }>(this.config, '/v2/status')

          const currentRound = status['last-round']
          if (currentRound > lastRound) {
            lastRound = currentRound
            callback(currentRound)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 3500))
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
   * Polls for new account activity by checking round changes.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastRound = 0
    let active = true

    // Get the current round to start from
    try {
      const status = await algodRequest<{
        'last-round': number
      }>(this.config, '/v2/status')
      lastRound = status['last-round']
    } catch {
      // Start from scratch
    }

    const poll = async () => {
      while (active) {
        try {
          const status = await algodRequest<{
            'last-round': number
          }>(this.config, '/v2/status')

          const currentRound = status['last-round']
          if (currentRound > lastRound) {
            // Check pending transactions for this address
            const pending = await algodRequest<{
              'top-transactions'?: Array<{
                txn: {
                  snd: string
                  rcv?: string
                  amt?: number
                  fee: number
                  fv: number
                }
              }>
              'total-transactions': number
            }>(this.config, `/v2/accounts/${address}/transactions/pending`)

            if (pending['top-transactions']) {
              for (const ptx of pending['top-transactions']) {
                if (!active) break
                const txInfo: TransactionInfo = {
                  hash: '',
                  from: ptx.txn.snd,
                  to: ptx.txn.rcv ?? null,
                  value: (ptx.txn.amt ?? 0).toString(),
                  fee: ptx.txn.fee.toString(),
                  blockNumber: null,
                  blockHash: null,
                  status: 'pending',
                  timestamp: null,
                }
                callback(txInfo)
              }
            }

            lastRound = currentRound
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 3500))
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

/**
 * Convert a hex string to Uint8Array.
 */
function hexToUint8Array(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(cleanHex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes

}
