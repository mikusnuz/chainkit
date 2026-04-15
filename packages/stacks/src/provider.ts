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
 * Configuration for StacksProvider.
 */
export interface StacksProviderConfig {
  /** Base URL for the Stacks Blockchain API (e.g., "https://api.mainnet.hiro.so") */
  baseUrl: string
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
  /** Network: mainnet or testnet */
  network?: 'mainnet' | 'testnet'
}

/**
 * Stacks provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses the Stacks Blockchain REST API (Hiro API) instead of JSON-RPC.
 */
export class StacksProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly baseUrl: string
  private readonly timeout: number
  private readonly network: 'mainnet' | 'testnet'

  constructor(config: StacksProviderConfig) {
    if (!config.baseUrl) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'baseUrl is required')
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.timeout = config.timeout ?? 10000
    this.network = config.network ?? 'mainnet'
  }

  /**
   * Make a GET request to the Stacks API.
   */
  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new ChainKitError(
          ErrorCode.NETWORK_ERROR,
          `HTTP ${response.status}: ${response.statusText}`,
          { path, status: response.status },
        )
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request timed out`, {
          path,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(
        ErrorCode.NETWORK_ERROR,
        `Request failed: ${(err as Error).message}`,
        { path },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Make a POST request to the Stacks API.
   */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new ChainKitError(
          ErrorCode.NETWORK_ERROR,
          `HTTP ${response.status}: ${response.statusText}`,
          { path, status: response.status },
        )
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request timed out`, {
          path,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(
        ErrorCode.NETWORK_ERROR,
        `Request failed: ${(err as Error).message}`,
        { path },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Make a POST request with raw hex body for broadcasting transactions.
   */
  private async postRaw(path: string, hexBody: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: hexToBuffer(hexBody),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new ChainKitError(
          ErrorCode.TRANSACTION_FAILED,
          `Broadcast failed: ${errorText}`,
          { path, status: response.status },
        )
      }

      // The API returns the txid as a JSON string
      const text = await response.text()
      return text.replace(/^"|"$/g, '')
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request timed out`, {
          path,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(
        ErrorCode.NETWORK_ERROR,
        `Request failed: ${(err as Error).message}`,
        { path },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  // ------- ChainProvider -------

  /**
   * Get the STX balance of an address.
   */
  async getBalance(address: Address): Promise<Balance> {
    interface AccountResponse {
      balance: string
      locked: string
      nonce: number
    }

    const account = await this.get<AccountResponse>(`/v2/accounts/${address}`)
    // The API returns balance as a hex string prefixed with 0x
    const balanceHex = account.balance
    const balanceMicro = balanceHex.startsWith('0x')
      ? BigInt(balanceHex).toString()
      : balanceHex

    return {
      address,
      amount: balanceMicro,
      symbol: 'STX',
      decimals: 6,
    }
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    interface TxResponse {
      tx_id: string
      sender_address: string
      token_transfer?: {
        recipient_address: string
        amount: string
        memo: string
      }
      fee_rate: string
      nonce: number
      block_height?: number
      block_hash?: string
      tx_status: string
      burn_block_time?: number
      tx_type: string
      tx_result?: { repr: string }
    }

    try {
      const tx = await this.get<TxResponse>(`/extended/v1/tx/${hash}`)

      let status: 'pending' | 'confirmed' | 'failed' = 'pending'
      if (tx.tx_status === 'success') {
        status = 'confirmed'
      } else if (tx.tx_status === 'abort_by_response' || tx.tx_status === 'abort_by_post_condition') {
        status = 'failed'
      }

      return {
        hash: tx.tx_id,
        from: tx.sender_address,
        to: tx.token_transfer?.recipient_address ?? null,
        value: tx.token_transfer?.amount ?? '0',
        fee: tx.fee_rate,
        blockNumber: tx.block_height ?? null,
        blockHash: tx.block_hash ?? null,
        status,
        timestamp: tx.burn_block_time ?? null,
        nonce: tx.nonce,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.NETWORK_ERROR) {
        const status = err.context?.status as number | undefined
        if (status === 404) return null
      }
      throw err
    }
  }

  /**
   * Get block details by number or hash.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    interface BlockResponse {
      height: number
      hash: string
      parent_block_hash: string
      burn_block_time: number
      txs: string[]
    }

    try {
      let block: BlockResponse

      if (typeof hashOrNumber === 'number') {
        block = await this.get<BlockResponse>(`/extended/v1/block/by_height/${hashOrNumber}`)
      } else if (hashOrNumber.startsWith('0x')) {
        block = await this.get<BlockResponse>(`/extended/v1/block/${hashOrNumber}`)
      } else {
        block = await this.get<BlockResponse>(`/extended/v1/block/by_height/${hashOrNumber}`)
      }

      return {
        number: block.height,
        hash: block.hash,
        parentHash: block.parent_block_hash,
        timestamp: block.burn_block_time,
        transactions: block.txs ?? [],
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.NETWORK_ERROR) {
        const status = err.context?.status as number | undefined
        if (status === 404) return null
      }
      throw err
    }
  }

  /**
   * Estimate transaction fees for a STX transfer.
   * Uses the /v2/fees/transfer endpoint.
   */
  async estimateFee(): Promise<FeeEstimate> {
    interface FeeResponse {
      estimated_cost: {
        write_count: number
        write_length: number
        read_count: number
        read_length: number
        runtime: number
      }
      estimated_cost_scalar: number
      estimations: Array<{
        fee: number
        fee_rate: number
      }>
      cost_scalar_change_by_byte: number
    }

    try {
      const fees = await this.get<FeeResponse>('/v2/fees/transfer')

      // The API returns estimations array with [low, middle, high]
      const estimations = fees.estimations ?? []
      const slow = estimations[0]?.fee ?? 200
      const average = estimations[1]?.fee ?? 500
      const fast = estimations[2]?.fee ?? 1000

      return {
        slow: slow.toString(),
        average: average.toString(),
        fast: fast.toString(),
        unit: 'microSTX',
      }
    } catch {
      // Fallback to reasonable defaults
      return {
        slow: '200',
        average: '500',
        fast: '1000',
        unit: 'microSTX',
      }
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   * The signedTx should be a hex-encoded serialized Stacks transaction.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    return this.postRaw('/v2/transactions', signedTx)
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    interface InfoResponse {
      peer_version: number
      pox_consensus: string
      burn_block_height: number
      stable_pox_consensus: string
      stable_burn_block_height: number
      server_version: string
      network_id: number
      parent_network_id: number
      stacks_tip_height: number
      stacks_tip: string
      stacks_tip_consensus_hash: string
      unanchored_tip: string
      exit_at_block_height: number
    }

    const info = await this.get<InfoResponse>('/v2/info')

    const isTestnet = this.network === 'testnet'

    return {
      chainId: info.network_id.toString(),
      name: isTestnet ? 'Stacks Testnet' : 'Stacks Mainnet',
      symbol: 'STX',
      decimals: 6,
      testnet: isTestnet,
      blockHeight: info.stacks_tip_height,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only contract method.
   * @param contractAddress - Full contract identifier "address.contract-name"
   * @param method - Function name
   * @param params - Clarity value arguments (hex-encoded)
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // contractAddress should be in format "SP.../ST... .contract-name"
    // or we accept "address.contract-name"
    const [address, contractName] = parseContractId(contractAddress)

    const body = {
      sender: address,
      arguments: (params ?? []).map((p) => String(p)),
    }

    interface ReadOnlyResponse {
      okay: boolean
      result?: string
      cause?: string
    }

    const result = await this.post<ReadOnlyResponse>(
      `/v2/contracts/call-read/${address}/${contractName}/${method}`,
      body,
    )

    if (!result.okay) {
      throw new ChainKitError(
        ErrorCode.TRANSACTION_FAILED,
        `Contract call failed: ${result.cause ?? 'unknown error'}`,
      )
    }

    return result.result
  }

  /**
   * Estimate gas (fee) for a contract call.
   * Stacks uses fee estimation rather than gas; this returns the estimated fee in microSTX.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    _params?: unknown[],
  ): Promise<string> {
    // Use the general fee estimation endpoint
    // For contract calls, fees are typically higher than transfers
    const feeEstimate = await this.estimateFee()
    // Return the average fee as a reasonable estimate
    // Contract calls typically cost more; multiply by a factor
    const baseFee = BigInt(feeEstimate.average)
    const contractFee = baseFee * 3n
    return contractFee.toString()
  }

  // ------- TokenCapable -------

  /**
   * Get the balance of a SIP-010 fungible token for an address.
   * @param address - The holder address
   * @param tokenAddress - The token contract identifier ("address.contract-name")
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    interface FtBalanceResponse {
      [key: string]: {
        balance: string
        total_sent: string
        total_received: string
      }
    }

    const response = await this.get<{ fungible_tokens: FtBalanceResponse }>(
      `/extended/v1/address/${address}/balances`,
    )

    const ftBalances = response.fungible_tokens ?? {}
    const tokenKey = Object.keys(ftBalances).find((key) =>
      key.includes(tokenAddress),
    )

    const balance = tokenKey ? ftBalances[tokenKey].balance : '0'

    return {
      address,
      amount: balance,
      symbol: 'FT',
      decimals: 6,
    }
  }

  /**
   * Get metadata for a SIP-010 fungible token.
   * @param tokenAddress - The token contract identifier ("address.contract-name")
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const [contractAddr, contractName] = parseContractId(tokenAddress)

    // Try to read name, symbol, decimals, total-supply via read-only calls
    let name = contractName
    let symbol = 'FT'
    let decimals = 6
    let totalSupply = '0'

    try {
      const nameResult = await this.callContract(tokenAddress, 'get-name') as string
      if (nameResult) {
        // Clarity returns (ok "name") - extract string
        const match = nameResult.match(/ok\s+"([^"]*)"/)
        if (match) name = match[1]
      }
    } catch {
      // Use contract name as fallback
    }

    try {
      const symbolResult = await this.callContract(tokenAddress, 'get-symbol') as string
      if (symbolResult) {
        const match = symbolResult.match(/ok\s+"([^"]*)"/)
        if (match) symbol = match[1]
      }
    } catch {
      // Use default
    }

    try {
      const decimalsResult = await this.callContract(tokenAddress, 'get-decimals') as string
      if (decimalsResult) {
        const match = decimalsResult.match(/ok\s+u(\d+)/)
        if (match) decimals = parseInt(match[1], 10)
      }
    } catch {
      // Use default
    }

    try {
      const supplyResult = await this.callContract(tokenAddress, 'get-total-supply') as string
      if (supplyResult) {
        const match = supplyResult.match(/ok\s+u(\d+)/)
        if (match) totalSupply = match[1]
      }
    } catch {
      // Use default
    }

    return {
      address: tokenAddress,
      name,
      symbol,
      decimals,
      totalSupply,
    }
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Polls every ~10 seconds (approximate Stacks block time varies).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const info = await this.getChainInfo()
          const blockNumber = info.blockHeight ?? 0

          if (blockNumber > lastBlockNumber) {
            lastBlockNumber = blockNumber
            callback(blockNumber)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 10000))
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
   * Polls the address activity endpoint every ~10 seconds.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastSeenTxId: string | null = null
    let active = true

    const poll = async () => {
      while (active) {
        try {
          interface ActivityResponse {
            results: Array<{
              tx: {
                tx_id: string
              }
            }>
          }

          const response = await this.get<ActivityResponse>(
            `/extended/v1/address/${address}/transactions?limit=1`,
          )

          if (response.results && response.results.length > 0) {
            const latestTxId = response.results[0].tx.tx_id
            if (lastSeenTxId !== null && latestTxId !== lastSeenTxId) {
              const txInfo = await this.getTransaction(latestTxId)
              if (txInfo) {
                callback(txInfo)
              }
            }
            lastSeenTxId = latestTxId
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 10000))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }
}

/**
 * Parse a contract identifier in the form "address.contract-name".
 */
function parseContractId(contractId: string): [string, string] {
  const dotIndex = contractId.indexOf('.')
  if (dotIndex < 0) {
    throw new ChainKitError(
      ErrorCode.INVALID_PARAMS,
      `Invalid contract identifier: "${contractId}". Expected format: "address.contract-name"`,
    )
  }
  return [contractId.slice(0, dotIndex), contractId.slice(dotIndex + 1)]
}

/**
 * Convert a hex string to a Uint8Array buffer for posting raw transactions.
 */
function hexToBuffer(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
