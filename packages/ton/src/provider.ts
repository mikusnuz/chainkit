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
 * Configuration for the TON provider.
 */
export interface TonProviderConfig {
  /** TON HTTP API v2 endpoint URL (e.g., "https://toncenter.com/api/v2") */
  endpoint: string
  /** Optional API key for rate limit bypass */
  apiKey?: string
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
}

/**
 * TON provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses TON HTTP API v2 (REST endpoints) instead of JSON-RPC.
 */
export class TonProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly endpoint: string
  private readonly apiKey?: string
  private readonly timeout: number

  constructor(config: TonProviderConfig) {
    if (!config.endpoint) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'TON API endpoint is required')
    }

    // Remove trailing slash
    this.endpoint = config.endpoint.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.timeout = config.timeout ?? 10000
  }

  /**
   * Make a GET request to the TON HTTP API.
   */
  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.endpoint}${path}`)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
      }
    }
    if (this.apiKey) {
      url.searchParams.set('api_key', this.apiKey)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new ChainKitError(ErrorCode.NETWORK_ERROR, `HTTP ${response.status}: ${response.statusText}`, {
          endpoint: this.endpoint,
          path,
          status: response.status,
        })
      }

      const json = await response.json() as { ok: boolean; result: T; error?: string }

      if (!json.ok) {
        throw new ChainKitError(ErrorCode.RPC_ERROR, json.error ?? 'Unknown TON API error', {
          endpoint: this.endpoint,
          path,
        })
      }

      return json.result
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${this.endpoint}${path} timed out`, {
          endpoint: this.endpoint,
          path,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(ErrorCode.NETWORK_ERROR, `Request failed: ${(err as Error).message}`, {
        endpoint: this.endpoint,
        path,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Make a POST request to the TON HTTP API.
   */
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = new URL(`${this.endpoint}${path}`)
    if (this.apiKey) {
      url.searchParams.set('api_key', this.apiKey)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new ChainKitError(ErrorCode.NETWORK_ERROR, `HTTP ${response.status}: ${response.statusText}`, {
          endpoint: this.endpoint,
          path,
          status: response.status,
        })
      }

      const json = await response.json() as { ok: boolean; result: T; error?: string }

      if (!json.ok) {
        throw new ChainKitError(ErrorCode.RPC_ERROR, json.error ?? 'Unknown TON API error', {
          endpoint: this.endpoint,
          path,
        })
      }

      return json.result
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${this.endpoint}${path} timed out`, {
          endpoint: this.endpoint,
          path,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(ErrorCode.NETWORK_ERROR, `Request failed: ${(err as Error).message}`, {
        endpoint: this.endpoint,
        path,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  // ------- ChainProvider -------

  /**
   * Get the TON balance of an address.
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.get<string>('/getAddressBalance', { address })

    return {
      address,
      amount: result,
      symbol: 'TON',
      decimals: 9,
    }
  }

  /**
   * Get transaction details.
   * TON uses the address + lt (logical time) + hash to identify transactions.
   * The hash parameter here is treated as the transaction hash.
   * We query recent transactions for the address and find the matching one.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    // TON API getTransactions requires an address, so we use the hash
    // as a lookup key. In practice, the hash format may include the address.
    // For now, we attempt to parse "address:lt:hash" format or return null.
    const parts = hash.split(':')

    if (parts.length < 3) {
      // Cannot look up by hash alone in TON HTTP API v2 without an address
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'TON transaction lookup requires format "address:lt:hash"',
      )
    }

    // Reconstruct address (may include workchain:hash format)
    const address = parts.slice(0, 2).join(':')
    const lt = parts[2]
    const txHash = parts[3] ?? ''

    const transactions = await this.get<TonApiTransaction[]>('/getTransactions', {
      address,
      limit: '10',
      lt,
      hash: txHash,
    })

    if (!transactions || transactions.length === 0) return null

    const tx = transactions[0]
    return this.mapTransaction(tx)
  }

  /**
   * Get block details by seqno (sequence number).
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    const seqno = typeof hashOrNumber === 'number' ? hashOrNumber : parseInt(hashOrNumber, 10)

    if (isNaN(seqno)) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'TON block lookup requires a sequence number')
    }

    try {
      // First get the shard info for the masterchain block
      const blockHeader = await this.get<TonBlockHeader>('/getBlockHeader', {
        workchain: '-1',
        shard: '-9223372036854775808',
        seqno: seqno.toString(),
      })

      if (!blockHeader) return null

      return {
        number: seqno,
        hash: blockHeader.id?.root_hash ?? '',
        parentHash: blockHeader.prev_blocks?.[0]?.root_hash ?? '',
        timestamp: blockHeader.gen_utime ?? 0,
        transactions: [],
      }
    } catch {
      return null
    }
  }

  /**
   * Get the wallet seqno (sequence number) for a TON address.
   * Uses the runGetMethod endpoint to call the 'seqno' getter on the wallet contract.
   */
  async getNonce(address: Address): Promise<number> {
    try {
      const result = await this.post<{ ok: boolean; result: { stack: Array<[string, string]> } }>('/runGetMethod', {
        address,
        method: 'seqno',
        stack: [],
      })
      if (result.ok && result.result.stack.length > 0) {
        const [, value] = result.result.stack[0]
        return parseInt(value, 16) || parseInt(value, 10) || 0
      }
      return 0
    } catch {
      return 0
    }
  }

  /**
   * Estimate transaction fees.
   * Uses the TON estimateFee endpoint.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // TON doesn't have a simple fee estimation endpoint without a specific transaction.
    // We provide a reasonable default based on typical TON transfer fees.
    // A simple TON transfer costs approximately 0.005-0.01 TON.
    return {
      slow: '5000000', // 0.005 TON in nanoton
      average: '10000000', // 0.01 TON
      fast: '50000000', // 0.05 TON
      unit: 'nanoton',
    }
  }

  /**
   * Estimate fee for a specific transaction.
   */
  async estimateTransactionFee(
    address: string,
    body: string,
    initCode?: string,
    initData?: string,
  ): Promise<{
    gasFee: string
    storageFee: string
    forwardFee: string
    totalFee: string
  }> {
    const result = await this.post<TonFeeEstimateResult>('/estimateFee', {
      address,
      body,
      init_code: initCode ?? '',
      init_data: initData ?? '',
    })

    const sourceFees = result.source_fees
    return {
      gasFee: sourceFees.gas_fee.toString(),
      storageFee: sourceFees.storage_fee.toString(),
      forwardFee: (sourceFees.fwd_fee + sourceFees.in_fwd_fee).toString(),
      totalFee: (
        sourceFees.gas_fee +
        sourceFees.storage_fee +
        sourceFees.fwd_fee +
        sourceFees.in_fwd_fee
      ).toString(),
    }
  }

  /**
   * Broadcast a signed BOC (Bag of Cells) transaction.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    // signedTx is a base64-encoded BOC string from TonSigner.signTransaction()
    // TON sendBocReturnHash expects base64-encoded BOC
    const boc = signedTx.startsWith('0x') ? signedTx.slice(2) : signedTx

    const result = await this.post<{ hash: string }>('/sendBocReturnHash', { boc })
    return result.hash ?? ''
  }

  /**
   * Get chain/network information from the masterchain.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const result = await this.get<TonMasterchainInfo>('/getMasterchainInfo')

    return {
      chainId: '-1', // TON masterchain workchain ID
      name: 'TON',
      symbol: 'TON',
      decimals: 9,
      testnet: this.endpoint.includes('testnet'),
      blockHeight: result.last?.seqno,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only contract method (GET method) using runGetMethod.
   * @param contractAddress - The contract address
   * @param method - The GET method name
   * @param params - Method parameters as stack entries
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // Build stack entries from params
    const stack = (params ?? []).map((param) => {
      if (typeof param === 'number' || typeof param === 'bigint') {
        return ['num', `0x${BigInt(param).toString(16)}`]
      }
      if (typeof param === 'string') {
        // If it looks like a number, send as num
        if (/^\d+$/.test(param)) {
          return ['num', `0x${BigInt(param).toString(16)}`]
        }
        return ['tvm.Slice', param]
      }
      return ['num', '0x0']
    })

    const result = await this.post<TonRunGetMethodResult>('/runGetMethod', {
      address: contractAddress,
      method,
      stack,
    })

    return result
  }

  /**
   * Estimate gas for a contract call.
   * TON doesn't have a direct gas estimation for GET methods,
   * so we return the gas_used from runGetMethod.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    const result = (await this.callContract(contractAddress, method, params)) as TonRunGetMethodResult
    return result.gas_used?.toString() ?? '0'
  }

  // ------- TokenCapable -------

  /**
   * Get the Jetton (TON token) balance for an address.
   * Queries the Jetton wallet contract associated with the address.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    // Call get_wallet_address on the Jetton master to find the wallet contract
    const walletResult = (await this.callContract(tokenAddress, 'get_wallet_address', [
      address,
    ])) as TonRunGetMethodResult

    if (walletResult.exit_code !== 0 || !walletResult.stack || walletResult.stack.length === 0) {
      return {
        address,
        amount: '0',
        symbol: 'JETTON',
        decimals: 9,
      }
    }

    // Extract the wallet address from the result stack
    const walletAddress = walletResult.stack[0]?.[1] as string ?? ''

    if (!walletAddress) {
      return {
        address,
        amount: '0',
        symbol: 'JETTON',
        decimals: 9,
      }
    }

    // Call get_wallet_data on the Jetton wallet to get the balance
    const balanceResult = (await this.callContract(
      walletAddress,
      'get_wallet_data',
    )) as TonRunGetMethodResult

    if (balanceResult.exit_code !== 0 || !balanceResult.stack || balanceResult.stack.length === 0) {
      return {
        address,
        amount: '0',
        symbol: 'JETTON',
        decimals: 9,
      }
    }

    const balance = balanceResult.stack[0]?.[1] as string ?? '0'
    // Parse hex number if needed
    const amount = balance.startsWith('0x')
      ? BigInt(balance).toString()
      : balance

    return {
      address,
      amount,
      symbol: 'JETTON',
      decimals: 9,
    }
  }

  /**
   * Get Jetton token metadata.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const result = (await this.callContract(
      tokenAddress,
      'get_jetton_data',
    )) as TonRunGetMethodResult

    if (result.exit_code !== 0 || !result.stack) {
      throw new ChainKitError(
        ErrorCode.RPC_ERROR,
        `Failed to get Jetton data for ${tokenAddress}`,
      )
    }

    // get_jetton_data returns: total_supply, mintable, admin_address, content, wallet_code
    const totalSupply = result.stack[0]?.[1] as string ?? '0'
    const supply = totalSupply.startsWith('0x')
      ? BigInt(totalSupply).toString()
      : totalSupply

    return {
      address: tokenAddress,
      name: 'Jetton',
      symbol: 'JETTON',
      decimals: 9,
      totalSupply: supply,
    }
  }

  /**
   * Get balances for multiple Jetton tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new masterchain blocks via polling.
   * TON produces blocks approximately every ~5 seconds.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastSeqno = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const info = await this.get<TonMasterchainInfo>('/getMasterchainInfo')
          const seqno = info.last?.seqno ?? 0

          if (seqno > lastSeqno) {
            lastSeqno = seqno
            callback(seqno)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 5000))
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
   * Polls every ~5 seconds and checks for new transactions.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastLt = '0'
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const transactions = await this.get<TonApiTransaction[]>('/getTransactions', {
            address,
            limit: '10',
          })

          if (transactions && transactions.length > 0) {
            for (const tx of transactions) {
              const lt = tx.transaction_id?.lt ?? '0'
              if (BigInt(lt) > BigInt(lastLt)) {
                const txInfo = this.mapTransaction(tx)
                if (txInfo) {
                  callback(txInfo)
                }
              }
            }
            // Update last logical time to the most recent
            lastLt = transactions[0].transaction_id?.lt ?? lastLt
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 5000))
        }
      }
    }

    // Initialize lastLt
    try {
      const transactions = await this.get<TonApiTransaction[]>('/getTransactions', {
        address,
        limit: '1',
      })
      if (transactions && transactions.length > 0) {
        lastLt = transactions[0].transaction_id?.lt ?? '0'
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

  // ------- Helpers -------

  /**
   * Map a TON API transaction to the common TransactionInfo format.
   */
  private mapTransaction(tx: TonApiTransaction): TransactionInfo {
    const inMsg = tx.in_msg
    const outMsgs = tx.out_msgs ?? []

    // Determine from/to/value from messages
    const from = inMsg?.source ?? ''
    const to = outMsgs.length > 0
      ? (outMsgs[0].destination ?? '')
      : (inMsg?.destination ?? '')
    const value = inMsg?.value
      ? BigInt(inMsg.value).toString()
      : '0'

    const fee = tx.fee ? BigInt(tx.fee).toString() : '0'

    return {
      hash: `${inMsg?.destination ?? ''}:${tx.transaction_id?.lt ?? '0'}:${tx.transaction_id?.hash ?? ''}`,
      from,
      to: to || null,
      value,
      fee,
      blockNumber: null, // TON uses seqno per shard, not a single block number
      blockHash: null,
      status: 'confirmed',
      timestamp: tx.utime ?? null,
      data: inMsg?.msg_data?.body ?? undefined,
      nonce: tx.transaction_id?.lt ? Number(BigInt(tx.transaction_id.lt) % BigInt(Number.MAX_SAFE_INTEGER)) : undefined,
    }
  }
}

// ------- TON API Response Types -------

interface TonApiTransaction {
  transaction_id?: {
    lt: string
    hash: string
  }
  fee?: string
  utime?: number
  in_msg?: {
    source?: string
    destination?: string
    value?: string
    msg_data?: {
      body?: string
    }
  }
  out_msgs?: Array<{
    source?: string
    destination?: string
    value?: string
  }>
}

interface TonMasterchainInfo {
  last?: {
    workchain: number
    shard: string
    seqno: number
    root_hash: string
    file_hash: string
  }
}

interface TonBlockHeader {
  id?: {
    workchain: number
    shard: string
    seqno: number
    root_hash: string
    file_hash: string
  }
  gen_utime?: number
  prev_blocks?: Array<{
    workchain: number
    shard: string
    seqno: number
    root_hash: string
    file_hash: string
  }>
}

interface TonFeeEstimateResult {
  source_fees: {
    in_fwd_fee: number
    storage_fee: number
    gas_fee: number
    fwd_fee: number
  }
}

interface TonRunGetMethodResult {
  gas_used?: number
  exit_code: number
  stack?: Array<[string, string]>
}
