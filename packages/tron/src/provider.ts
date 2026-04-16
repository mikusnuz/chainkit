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
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { addressToHex, hexToAddress } from './signer.js'

/**
 * Configuration for the Tron provider.
 */
export interface TronProviderConfig {
  /** Tron full node HTTP API URL (e.g., "https://api.trongrid.io") */
  endpoint: string
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
  /** Optional API key (for TronGrid) */
  apiKey?: string
}

/**
 * Compute the 4-byte function selector from a function signature.
 * e.g., "balanceOf(address)" -> "0x70a08231"
 */
function functionSelector(signature: string): string {
  const hash = keccak_256(new TextEncoder().encode(signature))
  return bytesToHex(hash).slice(0, 8)
}

/**
 * ABI-encode a Tron address as a 32-byte padded value.
 * Tron addresses in ABI encoding use the raw 20-byte address (without the 41 prefix).
 */
function encodeAddressParam(address: string): string {
  let hex: string
  if (address.startsWith('T')) {
    // Base58 Tron address -> hex, strip 41 prefix
    hex = addressToHex(address).slice(2) // remove '41' prefix
  } else if (address.startsWith('0x') || address.startsWith('41')) {
    const clean = address.startsWith('0x') ? address.slice(2) : address
    hex = clean.startsWith('41') ? clean.slice(2) : clean
  } else {
    hex = address
  }
  return hex.toLowerCase().padStart(64, '0')
}

/**
 * Decode an ABI-encoded string (returned from name/symbol calls).
 */
function decodeAbiString(hex: string): string {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex
  if (data.length < 128) return ''

  const lengthHex = data.slice(64, 128)
  const length = parseInt(lengthHex, 16)
  if (length === 0) return ''

  const strHex = data.slice(128, 128 + length * 2)
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(strHex.slice(i * 2, i * 2 + 2), 16)
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Tron provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses the Tron HTTP REST API (not JSON-RPC) to interact with Tron nodes.
 */
export class TronProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly endpoint: string
  private readonly timeout: number
  private readonly apiKey?: string

  constructor(config: TronProviderConfig) {
    if (!config.endpoint) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'Tron endpoint URL is required')
    }
    this.endpoint = config.endpoint.replace(/\/+$/, '')
    this.timeout = config.timeout ?? 10000
    this.apiKey = config.apiKey
  }

  /**
   * Send a POST request to the Tron HTTP API.
   */
  private async post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.endpoint}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.apiKey) {
      headers['TRON-PRO-API-KEY'] = this.apiKey
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new ChainKitError(ErrorCode.NETWORK_ERROR, `HTTP ${response.status}: ${response.statusText}`, {
          endpoint: url,
          status: response.status,
        })
      }

      const json = await response.json() as T & { Error?: string }

      // Tron API returns errors in a top-level "Error" field
      if (json && typeof json === 'object' && 'Error' in json && json.Error) {
        throw new ChainKitError(ErrorCode.RPC_ERROR, json.Error as string, { endpoint: url })
      }

      return json
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${url} timed out`, {
          endpoint: url,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(ErrorCode.NETWORK_ERROR, `Request to ${url} failed: ${(err as Error).message}`, {
        endpoint: url,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  // ------- ChainProvider -------

  /**
   * Get the TRX balance of an address.
   * Balance is returned in SUN (1 TRX = 1,000,000 SUN).
   */
  async getBalance(address: Address): Promise<Balance> {
    const hexAddress = address.startsWith('T') ? addressToHex(address) : address

    const result = await this.post<Record<string, unknown>>('/wallet/getaccount', {
      address: hexAddress,
      visible: false,
    })

    // If the account doesn't exist, balance is 0
    const balance = (result.balance as number) ?? 0

    return {
      address,
      amount: balance.toString(),
      symbol: 'TRX',
      decimals: 6,
    }
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    const cleanHash = hash.startsWith('0x') ? hash.slice(2) : hash

    const tx = await this.post<Record<string, unknown>>('/wallet/gettransactionbyid', {
      value: cleanHash,
    })

    // If not found, Tron returns an empty object
    if (!tx || !tx.txID) return null

    // Get transaction info for fee and status
    const txInfo = await this.post<Record<string, unknown>>('/wallet/gettransactioninfobyid', {
      value: cleanHash,
    })

    const rawData = tx.raw_data as Record<string, unknown> | undefined
    const contract = rawData?.contract as Array<Record<string, unknown>> | undefined
    const contractParam = contract?.[0]
    const paramValue = contractParam?.parameter as Record<string, unknown> | undefined
    const innerValue = paramValue?.value as Record<string, unknown> | undefined

    let from = ''
    let to: string | null = null
    let value = '0'

    if (innerValue) {
      const ownerHex = innerValue.owner_address as string | undefined
      const toHex = innerValue.to_address as string | undefined
      const amount = innerValue.amount as number | undefined

      if (ownerHex) from = hexToAddress(ownerHex)
      if (toHex) to = hexToAddress(toHex)
      if (amount !== undefined) value = amount.toString()
    }

    // Determine status
    const ret = tx.ret as Array<Record<string, string>> | undefined
    let status: 'pending' | 'confirmed' | 'failed' = 'pending'
    if (ret && ret.length > 0) {
      status = ret[0].contractRet === 'SUCCESS' ? 'confirmed' : 'failed'
    }

    // Fee from transaction info
    const fee = ((txInfo.fee as number) ?? 0).toString()

    // Block number and timestamp
    const blockNumber = (txInfo.blockNumber as number) ?? null
    const blockHash = (txInfo.blockHash as string) ?? null
    const timestamp = (txInfo.blockTimeStamp as number)
      ? Math.floor((txInfo.blockTimeStamp as number) / 1000)
      : null

    return {
      hash: tx.txID as string,
      from,
      to,
      value,
      fee,
      blockNumber,
      blockHash,
      status,
      timestamp,
    }
  }

  /**
   * Get block details by number or hash.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    let block: Record<string, unknown>

    if (typeof hashOrNumber === 'number') {
      block = await this.post<Record<string, unknown>>('/wallet/getblockbynum', {
        num: hashOrNumber,
      })
    } else {
      // Try as block hash
      block = await this.post<Record<string, unknown>>('/wallet/getblockbyid', {
        value: hashOrNumber,
      })
    }

    if (!block || !block.block_header) return null

    const header = block.block_header as Record<string, unknown>
    const rawData = header.raw_data as Record<string, unknown> | undefined

    const blockNumber = (rawData?.number as number) ?? 0
    const rawTimestamp = rawData?.timestamp as number | undefined
    const timestamp = rawTimestamp
      ? Math.floor(rawTimestamp / 1000)
      : 0
    const parentHash = (rawData?.parentHash as string) ?? ''
    const blockHash = (block.blockID as string) ?? ''

    // Extract transaction IDs
    const transactions = block.transactions as Array<Record<string, unknown>> | undefined
    const txHashes: string[] = (transactions ?? []).map((tx) => tx.txID as string)

    return {
      number: blockNumber,
      hash: blockHash,
      parentHash,
      timestamp,
      transactions: txHashes,
    }
  }

  /**
   * Get the latest nonce (transaction count) for a Tron address.
   * Tron does not have a traditional nonce; returns the transaction count from the account info.
   */
  async getNonce(address: Address): Promise<number> {
    try {
      const account = await this.post<Record<string, unknown>>('/wallet/getaccount', { address, visible: true })
      // Tron returns transaction count or 0 for new accounts
      return (account.net_window_size as number) ?? 0
    } catch {
      return 0
    }
  }

  /**
   * Estimate transaction fees.
   * Tron uses energy and bandwidth instead of gas. Returns estimates in SUN.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Tron doesn't have variable gas prices like Ethereum.
    // Bandwidth: 1000 free bandwidth per account per day.
    // A basic TRX transfer costs ~270 bandwidth.
    // If bandwidth is depleted, 1 bandwidth = 1000 SUN.
    // Energy is consumed by smart contract calls.

    const chainParams = await this.post<Record<string, unknown>>('/wallet/getchainparameters')
    const params = (chainParams.chainParameter as Array<Record<string, unknown>>) ?? []

    let transactionFee = 1000 // default SUN per bandwidth point
    let energyFee = 420 // default SUN per energy unit

    for (const p of params) {
      if (p.key === 'getTransactionFee') {
        transactionFee = (p.value as number) ?? transactionFee
      }
      if (p.key === 'getEnergyFee') {
        energyFee = (p.value as number) ?? energyFee
      }
    }

    // Estimate for a basic TRX transfer (~270 bandwidth)
    const bandwidthCost = 270
    const basicFee = (bandwidthCost * transactionFee).toString()

    return {
      slow: basicFee,
      average: basicFee,
      fast: basicFee,
      unit: 'SUN',
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   * Expects a JSON string containing the full signed transaction object.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    let txObj: Record<string, unknown>

    // signedTx can be a JSON string of the full transaction
    try {
      txObj = JSON.parse(signedTx)
    } catch {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'broadcastTransaction expects a JSON-encoded signed transaction object',
      )
    }

    const result = await this.post<Record<string, unknown>>('/wallet/broadcasttransaction', txObj)

    if (result.result !== true) {
      const msg = (result.message as string) ?? 'Broadcast failed'
      // Tron sometimes hex-encodes error messages
      let decodedMsg = msg
      try {
        if (/^[0-9a-fA-F]+$/.test(msg)) {
          const bytes = hexToBytes(msg)
          decodedMsg = new TextDecoder().decode(bytes)
        }
      } catch {
        // use original
      }
      throw new ChainKitError(ErrorCode.TRANSACTION_FAILED, decodedMsg)
    }

    return (result.txid as string) ?? (txObj.txID as string) ?? ''
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const block = await this.post<Record<string, unknown>>('/wallet/getnowblock')

    const header = block.block_header as Record<string, unknown> | undefined
    const rawData = header?.raw_data as Record<string, unknown> | undefined
    const blockHeight = (rawData?.number as number) ?? 0

    // Get node info to determine network
    let chainId = 'tron-mainnet'
    let name = 'Tron Mainnet'
    let testnet = false

    // Heuristic: if endpoint contains "shasta" or "nile", it's testnet
    if (this.endpoint.includes('shasta')) {
      chainId = 'tron-shasta'
      name = 'Tron Shasta Testnet'
      testnet = true
    } else if (this.endpoint.includes('nile')) {
      chainId = 'tron-nile'
      name = 'Tron Nile Testnet'
      testnet = true
    }

    return {
      chainId,
      name,
      symbol: 'TRX',
      decimals: 6,
      testnet,
      blockHeight,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only contract method (triggerConstantContract).
   * @param contractAddress - Contract address (base58 T... or hex)
   * @param method - Function signature (e.g., "balanceOf(address)") or pre-encoded call data
   * @param params - Parameters to ABI-encode
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    let data: string

    if (method.startsWith('0x')) {
      data = method.slice(2)
    } else {
      const selector = functionSelector(method)
      let encodedParams = ''
      if (params) {
        for (const param of params) {
          if (typeof param === 'string' && (param.startsWith('0x') || param.startsWith('T') || param.startsWith('41'))) {
            encodedParams += encodeAddressParam(param)
          } else if (typeof param === 'bigint') {
            encodedParams += param.toString(16).padStart(64, '0')
          } else if (typeof param === 'number') {
            encodedParams += param.toString(16).padStart(64, '0')
          } else {
            encodedParams += String(param).padStart(64, '0')
          }
        }
      }
      data = selector + encodedParams
    }

    const contractHex = contractAddress.startsWith('T')
      ? addressToHex(contractAddress)
      : contractAddress

    // Use a zero address as owner for read-only calls
    const ownerAddress = '410000000000000000000000000000000000000000'

    const result = await this.post<Record<string, unknown>>('/wallet/triggerconstantcontract', {
      owner_address: ownerAddress,
      contract_address: contractHex,
      function_selector: method.startsWith('0x') ? '' : method,
      parameter: method.startsWith('0x') ? data.slice(8) : data.slice(8),
      visible: false,
    })

    const constantResult = result.constant_result as string[] | undefined
    if (constantResult && constantResult.length > 0) {
      return '0x' + constantResult[0]
    }

    return null
  }

  /**
   * Estimate energy for a contract call.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    let data: string

    if (method.startsWith('0x')) {
      data = method.slice(2)
    } else {
      const selector = functionSelector(method)
      let encodedParams = ''
      if (params) {
        for (const param of params) {
          if (typeof param === 'string' && (param.startsWith('0x') || param.startsWith('T') || param.startsWith('41'))) {
            encodedParams += encodeAddressParam(param)
          } else if (typeof param === 'bigint') {
            encodedParams += param.toString(16).padStart(64, '0')
          } else if (typeof param === 'number') {
            encodedParams += param.toString(16).padStart(64, '0')
          } else {
            encodedParams += String(param).padStart(64, '0')
          }
        }
      }
      data = selector + encodedParams
    }

    const contractHex = contractAddress.startsWith('T')
      ? addressToHex(contractAddress)
      : contractAddress

    const ownerAddress = '410000000000000000000000000000000000000000'

    const result = await this.post<Record<string, unknown>>('/wallet/triggerconstantcontract', {
      owner_address: ownerAddress,
      contract_address: contractHex,
      function_selector: method.startsWith('0x') ? '' : method,
      parameter: method.startsWith('0x') ? data.slice(8) : data.slice(8),
      visible: false,
    })

    const energyUsed = (result.energy_used as number) ?? 0
    return energyUsed.toString()
  }

  // ------- TokenCapable -------

  /**
   * Get the TRC-20 token balance for an address.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    // balanceOf(address)
    const selector = functionSelector('balanceOf(address)')
    const encodedAddress = encodeAddressParam(address)
    const data = selector + encodedAddress

    const contractHex = tokenAddress.startsWith('T')
      ? addressToHex(tokenAddress)
      : tokenAddress

    const ownerHex = address.startsWith('T')
      ? addressToHex(address)
      : address

    const [balanceResult, decimalsResult, symbolResult] = await Promise.all([
      this.post<Record<string, unknown>>('/wallet/triggerconstantcontract', {
        owner_address: ownerHex,
        contract_address: contractHex,
        function_selector: 'balanceOf(address)',
        parameter: encodedAddress,
        visible: false,
      }),
      this.post<Record<string, unknown>>('/wallet/triggerconstantcontract', {
        owner_address: ownerHex,
        contract_address: contractHex,
        function_selector: 'decimals()',
        parameter: '',
        visible: false,
      }),
      this.post<Record<string, unknown>>('/wallet/triggerconstantcontract', {
        owner_address: ownerHex,
        contract_address: contractHex,
        function_selector: 'symbol()',
        parameter: '',
        visible: false,
      }),
    ])

    const balanceHex = (balanceResult.constant_result as string[])?.[0] ?? '0'
    const decimalsHex = (decimalsResult.constant_result as string[])?.[0] ?? '0'
    const symbolHex = (symbolResult.constant_result as string[])?.[0] ?? ''

    const balance = balanceHex === '0' ? 0n : BigInt('0x' + balanceHex)
    const decimals = decimalsHex === '0' ? 0 : Number(BigInt('0x' + decimalsHex))
    const symbol = decodeAbiString(symbolHex)

    return {
      address,
      amount: balance.toString(),
      symbol,
      decimals,
    }
  }

  /**
   * Get metadata for a TRC-20 token.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const contractHex = tokenAddress.startsWith('T')
      ? addressToHex(tokenAddress)
      : tokenAddress

    const ownerAddress = '410000000000000000000000000000000000000000'

    const [nameResult, symbolResult, decimalsResult, totalSupplyResult] = await Promise.all([
      this.post<Record<string, unknown>>('/wallet/triggerconstantcontract', {
        owner_address: ownerAddress,
        contract_address: contractHex,
        function_selector: 'name()',
        parameter: '',
        visible: false,
      }),
      this.post<Record<string, unknown>>('/wallet/triggerconstantcontract', {
        owner_address: ownerAddress,
        contract_address: contractHex,
        function_selector: 'symbol()',
        parameter: '',
        visible: false,
      }),
      this.post<Record<string, unknown>>('/wallet/triggerconstantcontract', {
        owner_address: ownerAddress,
        contract_address: contractHex,
        function_selector: 'decimals()',
        parameter: '',
        visible: false,
      }),
      this.post<Record<string, unknown>>('/wallet/triggerconstantcontract', {
        owner_address: ownerAddress,
        contract_address: contractHex,
        function_selector: 'totalSupply()',
        parameter: '',
        visible: false,
      }),
    ])

    const nameHex = (nameResult.constant_result as string[])?.[0] ?? ''
    const symbolHex = (symbolResult.constant_result as string[])?.[0] ?? ''
    const decimalsHex = (decimalsResult.constant_result as string[])?.[0] ?? '0'
    const totalSupplyHex = (totalSupplyResult.constant_result as string[])?.[0] ?? '0'

    return {
      address: tokenAddress,
      name: decodeAbiString(nameHex),
      symbol: decodeAbiString(symbolHex),
      decimals: decimalsHex === '0' ? 0 : Number(BigInt('0x' + decimalsHex)),
      totalSupply: totalSupplyHex === '0' ? '0' : BigInt('0x' + totalSupplyHex).toString(),
    }
  }

  /**
   * Get balances for multiple TRC-20 tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Polls every ~3 seconds (Tron block time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const block = await this.post<Record<string, unknown>>('/wallet/getnowblock')
          const header = block.block_header as Record<string, unknown> | undefined
          const rawData = header?.raw_data as Record<string, unknown> | undefined
          const blockNumber = (rawData?.number as number) ?? 0

          if (blockNumber > lastBlockNumber) {
            lastBlockNumber = blockNumber
            callback(blockNumber)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 3000))
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
   * Polls every ~3 seconds and checks new blocks for matching transactions.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    // Normalize the address for comparison
    const normalizedHex = address.startsWith('T')
      ? addressToHex(address).toLowerCase()
      : address.toLowerCase()

    const poll = async () => {
      while (active) {
        try {
          const block = await this.post<Record<string, unknown>>('/wallet/getnowblock')
          const header = block.block_header as Record<string, unknown> | undefined
          const rawData = header?.raw_data as Record<string, unknown> | undefined
          const currentBlock = (rawData?.number as number) ?? 0

          if (currentBlock > lastBlockNumber) {
            for (let blockNum = lastBlockNumber + 1; blockNum <= currentBlock && active; blockNum++) {
              const blockData = await this.post<Record<string, unknown>>('/wallet/getblockbynum', {
                num: blockNum,
              })

              const transactions = blockData.transactions as Array<Record<string, unknown>> | undefined
              if (transactions) {
                for (const tx of transactions) {
                  const rd = tx.raw_data as Record<string, unknown> | undefined
                  const contracts = rd?.contract as Array<Record<string, unknown>> | undefined
                  const param = contracts?.[0]?.parameter as Record<string, unknown> | undefined
                  const val = param?.value as Record<string, unknown> | undefined

                  const ownerAddr = ((val?.owner_address as string) ?? '').toLowerCase()
                  const toAddr = ((val?.to_address as string) ?? '').toLowerCase()

                  if (ownerAddr === normalizedHex || toAddr === normalizedHex) {
                    const txInfo = await this.getTransaction(tx.txID as string)
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
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }
      }
    }

    // Initialize lastBlockNumber
    try {
      const block = await this.post<Record<string, unknown>>('/wallet/getnowblock')
      const header = block.block_header as Record<string, unknown> | undefined
      const rawData = header?.raw_data as Record<string, unknown> | undefined
      lastBlockNumber = (rawData?.number as number) ?? 0
    } catch {
      // Start from 0
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
