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
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'
import type { VeChainProviderConfig } from './types.js'

/**
 * Compute the 4-byte function selector from a function signature.
 * e.g., "balanceOf(address)" -> "0x70a08231"
 */
function functionSelector(signature: string): string {
  const hash = keccak_256(new TextEncoder().encode(signature))
  return '0x' + bytesToHex(hash).slice(0, 8)
}

/**
 * ABI-encode an address as a 32-byte padded value.
 */
function encodeAddress(address: string): string {
  const clean = address.startsWith('0x') ? address.slice(2) : address
  return clean.toLowerCase().padStart(64, '0')
}

/**
 * Parse a hex string to a BigInt.
 */
function hexToBigInt(hex: string): bigint {
  if (!hex || hex === '0x' || hex === '0x0') return 0n
  return BigInt(hex)
}

/**
 * Decode a hex-encoded ABI string (returned from name/symbol calls).
 * ABI encoding: offset (32 bytes) + length (32 bytes) + data (padded to 32 bytes)
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
 * VeChain provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses the Thorest REST API (not JSON-RPC) to interact with VeChain nodes.
 *
 * Key API endpoints:
 * - GET /accounts/{address} - get account balance
 * - GET /transactions/{id} - get transaction by ID
 * - GET /transactions/{id}/receipt - get transaction receipt
 * - GET /blocks/{revision} - get block by number or ID
 * - POST /transactions - broadcast transaction
 */
export class VeChainProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly baseUrl: string
  private readonly timeout: number

  constructor(config: VeChainProviderConfig) {
    if (!config.url) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'VeChain REST API URL is required')
    }
    // Remove trailing slash
    this.baseUrl = config.url.replace(/\/+$/, '')
    this.timeout = config.timeout ?? 10000
  }

  /**
   * Send a GET request to the Thorest API.
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
        throw new ChainKitError(ErrorCode.NETWORK_ERROR, `HTTP ${response.status}: ${response.statusText}`, {
          endpoint: this.baseUrl,
          path,
          status: response.status,
        })
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${this.baseUrl}${path} timed out`, {
          endpoint: this.baseUrl,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(ErrorCode.NETWORK_ERROR, `Request failed: ${(err as Error).message}`, {
        endpoint: this.baseUrl,
        path,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Send a POST request to the Thorest API.
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
        const errorBody = await response.text().catch(() => '')
        throw new ChainKitError(ErrorCode.NETWORK_ERROR, `HTTP ${response.status}: ${response.statusText}`, {
          endpoint: this.baseUrl,
          path,
          status: response.status,
          body: errorBody,
        })
      }

      return (await response.json()) as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${this.baseUrl}${path} timed out`, {
          endpoint: this.baseUrl,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(ErrorCode.NETWORK_ERROR, `Request failed: ${(err as Error).message}`, {
        endpoint: this.baseUrl,
        path,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  // ------- ChainProvider -------

  /**
   * Get the VET balance of an address.
   * Uses GET /accounts/{address}
   */
  async getBalance(address: Address): Promise<Balance> {
    const account = await this.get<{
      balance: string
      energy: string
      hasCode: boolean
    }>(`/accounts/${address}`)

    const wei = hexToBigInt(account.balance)

    return {
      address,
      amount: wei.toString(),
      symbol: 'VET',
      decimals: 18,
    }
  }

  /**
   * Get transaction details by hash/ID.
   * Uses GET /transactions/{id} and GET /transactions/{id}/receipt
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    const tx = await this.get<{
      id: string
      chainTag: number
      blockRef: string
      expiration: number
      clauses: Array<{ to: string; value: string; data: string }>
      gasPriceCoef: number
      gas: number
      origin: string
      delegator: string | null
      nonce: string
      dependsOn: string | null
      size: number
      meta: {
        blockID: string
        blockNumber: number
        blockTimestamp: number
      } | null
    } | null>(`/transactions/${hash}`)

    if (!tx) return null

    // Get receipt for status and gas used
    let status: 'pending' | 'confirmed' | 'failed' = 'pending'
    let fee = '0'
    let blockNumber: number | null = null
    let blockHash: string | null = null
    let timestamp: number | null = null

    if (tx.meta) {
      blockNumber = tx.meta.blockNumber
      blockHash = tx.meta.blockID
      timestamp = tx.meta.blockTimestamp

      const receipt = await this.get<{
        gasUsed: number
        gasPayer: string
        paid: string
        reward: string
        reverted: boolean
        meta: {
          blockID: string
          blockNumber: number
          blockTimestamp: number
        }
        outputs: Array<{
          contractAddress: string | null
          events: Array<unknown>
          transfers: Array<unknown>
        }>
      } | null>(`/transactions/${hash}/receipt`)

      if (receipt) {
        status = receipt.reverted ? 'failed' : 'confirmed'
        fee = hexToBigInt(receipt.paid).toString()
      }
    }

    // Sum values across all clauses
    const totalValue = tx.clauses.reduce((sum, clause) => {
      return sum + hexToBigInt(clause.value)
    }, 0n)

    // Use first clause's 'to' address (or null for contract creation)
    const to = tx.clauses.length > 0 ? tx.clauses[0].to : null

    return {
      hash: tx.id,
      from: tx.origin,
      to,
      value: totalValue.toString(),
      fee,
      blockNumber,
      blockHash,
      status,
      timestamp,
      data: tx.clauses.length > 0 && tx.clauses[0].data !== '0x' ? tx.clauses[0].data : undefined,
    }
  }

  /**
   * Get block details by number or ID.
   * Uses GET /blocks/{revision}
   * Accepts block number (as number or string) or block ID (hash).
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    const revision = typeof hashOrNumber === 'number' ? hashOrNumber.toString() : hashOrNumber

    const block = await this.get<{
      number: number
      id: string
      size: number
      parentID: string
      timestamp: number
      gasLimit: number
      beneficiary: string
      gasUsed: number
      totalScore: number
      txsRoot: string
      txsFeatures: number
      stateRoot: string
      receiptsRoot: string
      com: boolean
      signer: string
      isTrunk: boolean
      isFinalized: boolean
      transactions: string[]
    } | null>(`/blocks/${revision}`)

    if (!block) return null

    return {
      number: block.number,
      hash: block.id,
      parentHash: block.parentID,
      timestamp: block.timestamp,
      transactions: block.transactions ?? [],
    }
  }

  /**
   * Get the nonce for an address.
   * VeChain uses random nonces (not sequential), so this always returns 0.
   * Transactions use randomly generated nonces instead of sequential counters.
   */
  async getNonce(_address: Address): Promise<number> {
    return 0
  }

  /**
   * Estimate transaction fees.
   * VeChain uses a different fee model with VTHO as gas token.
   * Base gas price is fixed; gasPriceCoef adjusts it (0-255).
   * Fee = gasUsed * baseGasPrice * (1 + gasPriceCoef / 255)
   */
  async estimateFee(): Promise<FeeEstimate> {
    // VeChain base gas price is 1e15 wei (0.001 VTHO per gas unit)
    // Simple transfer costs 21000 gas = 21 VTHO (base)
    const baseGasPrice = 1000000000000000n // 1e15 wei
    const transferGas = 21000n

    // Slow: gasPriceCoef = 0 (minimum)
    const slow = (transferGas * baseGasPrice) / 10n ** 18n
    // Average: gasPriceCoef = 128 (~50%)
    const average = (transferGas * baseGasPrice * (255n + 128n)) / (255n * 10n ** 18n)
    // Fast: gasPriceCoef = 255 (maximum, 2x base)
    const fast = (transferGas * baseGasPrice * 2n) / 10n ** 18n

    return {
      slow: slow.toString(),
      average: average.toString(),
      fast: fast.toString(),
      unit: 'VTHO',
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   * Uses POST /transactions with { raw: "0x..." }
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const result = await this.post<{ id: string }>('/transactions', {
      raw: signedTx,
    })

    return result.id
  }

  /**
   * Get chain/network information.
   * Uses GET /blocks/0 (genesis block) to determine network.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [genesis, best] = await Promise.all([
      this.get<{ number: number; id: string; timestamp: number }>('/blocks/0'),
      this.get<{ number: number; id: string; timestamp: number }>('/blocks/best'),
    ])

    // Determine network from genesis block ID
    const mainnetGenesis = '0x00000000851caf3cfdb6e899cf5958bfb1ac3413d346d43539627e6be7ec1b4a'
    const testnetGenesis = '0x000000000b2bce3c70bc649a02749e8687721b09ed2e15997f466536b20bb127'

    let name = 'VeChain Unknown'
    let testnet = false

    if (genesis.id === mainnetGenesis) {
      name = 'VeChain Mainnet'
    } else if (genesis.id === testnetGenesis) {
      name = 'VeChain Testnet'
      testnet = true
    } else {
      name = 'VeChain Private'
      testnet = true
    }

    // Chain tag is the last byte of genesis block ID
    const chainTag = parseInt(genesis.id.slice(-2), 16)

    return {
      chainId: chainTag.toString(),
      name,
      symbol: 'VET',
      decimals: 18,
      testnet,
      blockHeight: best.number,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only contract method.
   * Uses POST /accounts/{contractAddress} with { value: "0x0", data: "0x..." }
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    let data: string

    if (method.startsWith('0x')) {
      data = method
    } else {
      const selector = functionSelector(method)
      let encodedParams = ''
      if (params) {
        for (const param of params) {
          if (typeof param === 'string' && param.startsWith('0x')) {
            encodedParams += encodeAddress(param)
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

    const result = await this.post<{
      data: string
      events: unknown[]
      transfers: unknown[]
      gasUsed: number
      reverted: boolean
      vmError: string
    }[]>(`/accounts/${contractAddress}`, {
      clauses: [{ to: contractAddress, value: '0x0', data }],
    })

    if (!result || result.length === 0) {
      throw new ChainKitError(ErrorCode.RPC_ERROR, 'Empty response from contract call')
    }

    if (result[0].reverted) {
      throw new ChainKitError(ErrorCode.TRANSACTION_FAILED, `Contract call reverted: ${result[0].vmError}`)
    }

    return result[0].data
  }

  /**
   * Estimate gas for a contract call.
   * Uses POST /accounts/* (inspect endpoint) to simulate execution.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    let data: string

    if (method.startsWith('0x')) {
      data = method
    } else {
      const selector = functionSelector(method)
      let encodedParams = ''
      if (params) {
        for (const param of params) {
          if (typeof param === 'string' && param.startsWith('0x')) {
            encodedParams += encodeAddress(param)
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

    const result = await this.post<{
      data: string
      events: unknown[]
      transfers: unknown[]
      gasUsed: number
      reverted: boolean
      vmError: string
    }[]>(`/accounts/${contractAddress}`, {
      clauses: [{ to: contractAddress, value: '0x0', data }],
    })

    if (!result || result.length === 0) {
      throw new ChainKitError(ErrorCode.RPC_ERROR, 'Empty response from gas estimation')
    }

    // Add 15% buffer to gas estimate
    const gasUsed = Math.ceil(result[0].gasUsed * 1.15)
    return gasUsed.toString()
  }

  // ------- TokenCapable -------

  /**
   * Get the VIP-180 (ERC-20 compatible) token balance for an address.
   * VTHO is the native energy token at a known contract address.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    const selector = functionSelector('balanceOf(address)')
    const data = selector + encodeAddress(address)

    const [balanceResult, decimalsResult, symbolResult] = await Promise.all([
      this.post<{ data: string; reverted: boolean }[]>(`/accounts/${tokenAddress}`, {
        clauses: [{ to: tokenAddress, value: '0x0', data }],
      }),
      this.post<{ data: string; reverted: boolean }[]>(`/accounts/${tokenAddress}`, {
        clauses: [{ to: tokenAddress, value: '0x0', data: functionSelector('decimals()') }],
      }),
      this.post<{ data: string; reverted: boolean }[]>(`/accounts/${tokenAddress}`, {
        clauses: [{ to: tokenAddress, value: '0x0', data: functionSelector('symbol()') }],
      }),
    ])

    const balance = hexToBigInt(balanceResult[0]?.data ?? '0x0')
    const decimals = Number(hexToBigInt(decimalsResult[0]?.data ?? '0x12'))
    const symbol = decodeAbiString(symbolResult[0]?.data ?? '')

    return {
      address,
      amount: balance.toString(),
      symbol: symbol || 'UNKNOWN',
      decimals,
    }
  }

  /**
   * Get metadata for a VIP-180 (ERC-20 compatible) token.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const [nameResult, symbolResult, decimalsResult, totalSupplyResult] = await Promise.all([
      this.post<{ data: string; reverted: boolean }[]>(`/accounts/${tokenAddress}`, {
        clauses: [{ to: tokenAddress, value: '0x0', data: functionSelector('name()') }],
      }),
      this.post<{ data: string; reverted: boolean }[]>(`/accounts/${tokenAddress}`, {
        clauses: [{ to: tokenAddress, value: '0x0', data: functionSelector('symbol()') }],
      }),
      this.post<{ data: string; reverted: boolean }[]>(`/accounts/${tokenAddress}`, {
        clauses: [{ to: tokenAddress, value: '0x0', data: functionSelector('decimals()') }],
      }),
      this.post<{ data: string; reverted: boolean }[]>(`/accounts/${tokenAddress}`, {
        clauses: [{ to: tokenAddress, value: '0x0', data: functionSelector('totalSupply()') }],
      }),
    ])

    return {
      address: tokenAddress,
      name: decodeAbiString(nameResult[0]?.data ?? ''),
      symbol: decodeAbiString(symbolResult[0]?.data ?? ''),
      decimals: Number(hexToBigInt(decimalsResult[0]?.data ?? '0x12')),
      totalSupply: hexToBigInt(totalSupplyResult[0]?.data ?? '0x0').toString(),
    }
  }

  /**
   * Get balances for multiple VIP-180 tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * VeChain produces blocks every ~10 seconds.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const block = await this.get<{ number: number }>('/blocks/best')
          if (block.number > lastBlockNumber) {
            lastBlockNumber = block.number
            callback(block.number)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 10000))
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
   * Polls every ~10 seconds and checks new blocks for matching transactions.
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
          const bestBlock = await this.get<{ number: number }>('/blocks/best')

          if (bestBlock.number > lastBlockNumber) {
            for (
              let blockNum = lastBlockNumber + 1;
              blockNum <= bestBlock.number && active;
              blockNum++
            ) {
              const block = await this.get<{
                number: number
                transactions: string[]
              }>(`/blocks/${blockNum}`)

              if (block && block.transactions) {
                for (const txId of block.transactions) {
                  const txInfo = await this.getTransaction(txId)
                  if (txInfo) {
                    if (
                      txInfo.from?.toLowerCase() === normalizedAddress ||
                      txInfo.to?.toLowerCase() === normalizedAddress
                    ) {
                      callback(txInfo)
                    }
                  }
                }
              }
            }
            lastBlockNumber = bestBlock.number
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 10000))
        }
      }
    }

    // Initialize lastBlockNumber
    try {
      const block = await this.get<{ number: number }>('/blocks/best')
      lastBlockNumber = block.number
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
