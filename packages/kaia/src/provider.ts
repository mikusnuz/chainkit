import {
  RpcManager,
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
  RpcManagerConfig,
} from '@chainkit/core'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'
import type { KaiaFeeDetail } from './types.js'

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
 * Parse a hex string to a number.
 */
function hexToNumber(hex: string): number {
  if (!hex || hex === '0x' || hex === '0x0') return 0
  return Number(BigInt(hex))
}

/**
 * Decode a hex-encoded ABI string (returned from name/symbol calls).
 * ABI encoding: offset (32 bytes) + length (32 bytes) + data (padded to 32 bytes)
 */
function decodeAbiString(hex: string): string {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex
  if (data.length < 128) return ''

  // Read length (next 32 bytes after offset)
  const lengthHex = data.slice(64, 128)
  const length = parseInt(lengthHex, 16)

  if (length === 0) return ''

  // Read string data
  const strHex = data.slice(128, 128 + length * 2)
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(strHex.slice(i * 2, i * 2 + 2), 16)
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Kaia provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses Kaia JSON-RPC (klay_ prefix) via an internal RpcManager.
 * Kaia is EVM-compatible but uses `klay_` method prefix for its native RPC methods.
 */
export class KaiaProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the KLAY balance of an address.
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.rpc.request<string>('klay_getBalance', [address, 'latest'])
    const peb = hexToBigInt(result)

    return {
      address,
      amount: peb.toString(),
      symbol: 'KLAY',
      decimals: 18,
    }
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    const tx = await this.rpc.request<Record<string, string> | null>(
      'klay_getTransactionByHash',
      [hash],
    )

    if (!tx) return null

    // Fetch receipt for status
    let status: 'pending' | 'confirmed' | 'failed' = 'pending'
    let fee = '0'
    if (tx.blockNumber) {
      const receipt = await this.rpc.request<Record<string, string> | null>(
        'klay_getTransactionReceipt',
        [hash],
      )
      if (receipt) {
        status = receipt.status === '0x1' ? 'confirmed' : 'failed'
        const gasUsed = hexToBigInt(receipt.gasUsed)
        const effectiveGasPrice = hexToBigInt(receipt.effectiveGasPrice ?? tx.gasPrice)
        fee = (gasUsed * effectiveGasPrice).toString()
      }
    }

    // Get block timestamp if confirmed
    let timestamp: number | null = null
    if (tx.blockHash && tx.blockHash !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
      const block = await this.rpc.request<Record<string, string> | null>(
        'klay_getBlockByHash',
        [tx.blockHash, false],
      )
      if (block) {
        timestamp = hexToNumber(block.timestamp)
      }
    }

    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to ?? null,
      value: hexToBigInt(tx.value).toString(),
      fee,
      blockNumber: tx.blockNumber ? hexToNumber(tx.blockNumber) : null,
      blockHash: tx.blockHash ?? null,
      status,
      timestamp,
      data: tx.input !== '0x' ? tx.input : undefined,
      nonce: hexToNumber(tx.nonce),
    }
  }

  /**
   * Get block details by number or hash.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    let block: Record<string, unknown> | null

    if (typeof hashOrNumber === 'number') {
      const blockTag = '0x' + hashOrNumber.toString(16)
      block = await this.rpc.request<Record<string, unknown> | null>(
        'klay_getBlockByNumber',
        [blockTag, false],
      )
    } else if (hashOrNumber.startsWith('0x') && hashOrNumber.length === 66) {
      // Block hash (32 bytes = 64 hex chars + 0x prefix)
      block = await this.rpc.request<Record<string, unknown> | null>(
        'klay_getBlockByHash',
        [hashOrNumber, false],
      )
    } else {
      // Treat as hex block number
      block = await this.rpc.request<Record<string, unknown> | null>(
        'klay_getBlockByNumber',
        [hashOrNumber, false],
      )
    }

    if (!block) return null

    return {
      number: hexToNumber(block.number as string),
      hash: block.hash as string,
      parentHash: block.parentHash as string,
      timestamp: hexToNumber(block.timestamp as string),
      transactions: (block.transactions as string[]) ?? [],
    }
  }

  /**
   * Get the transaction count (nonce) for a Kaia address.
   */
  async getNonce(address: Address): Promise<number> {
    const result = await this.rpc.request<string>('klay_getTransactionCount', [address, 'latest'])
    return hexToNumber(result)
  }

  /**
   * Estimate transaction fees using EIP-1559 parameters.
   * Kaia uses a similar gas model to Ethereum.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Fetch latest block for baseFee and gas price
    const [latestBlock, gasPrice] = await Promise.all([
      this.rpc.request<Record<string, string>>('klay_getBlockByNumber', ['latest', false]),
      this.rpc.request<string>('klay_gasPrice', []),
    ])

    const baseFee = hexToBigInt(latestBlock.baseFeePerGas ?? '0x0')
    const currentGasPrice = hexToBigInt(gasPrice)

    // Use baseFee if available (post-Magma hard fork), otherwise use gasPrice
    let slow: bigint
    let average: bigint
    let fast: bigint

    if (baseFee > 0n) {
      // Kaia uses a fixed tip model after Magma
      const tip = currentGasPrice > baseFee ? currentGasPrice - baseFee : 0n
      slow = baseFee + tip
      average = (baseFee * 125n) / 100n + (tip * 150n) / 100n
      fast = (baseFee * 150n) / 100n + tip * 2n
    } else {
      slow = currentGasPrice
      average = (currentGasPrice * 120n) / 100n
      fast = (currentGasPrice * 150n) / 100n
    }

    // Convert from peb to Gpeb (Gwei equivalent) for display
    const toGpeb = (peb: bigint) => {
      const gpeb = Number(peb) / 1e9
      return gpeb.toFixed(2)
    }

    return {
      slow: toGpeb(slow),
      average: toGpeb(average),
      fast: toGpeb(fast),
      unit: 'Gpeb',
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    return this.rpc.request<string>('klay_sendRawTransaction', [signedTx])
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [chainIdHex, blockNumberHex] = await Promise.all([
      this.rpc.request<string>('klay_chainID', []),
      this.rpc.request<string>('klay_blockNumber', []),
    ])

    const chainId = hexToNumber(chainIdHex)
    const blockHeight = hexToNumber(blockNumberHex)

    // Map common Kaia chain IDs to names
    const chainNames: Record<number, { name: string; testnet: boolean }> = {
      8217: { name: 'Kaia Mainnet', testnet: false },
      1001: { name: 'Kaia Kairos Testnet', testnet: true },
    }

    const info = chainNames[chainId] ?? {
      name: `Kaia Chain ${chainId}`,
      testnet: chainId !== 8217,
    }

    return {
      chainId: chainId.toString(),
      name: info.name,
      symbol: 'KLAY',
      decimals: 18,
      testnet: info.testnet,
      blockHeight,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only contract method.
   * @param contractAddress - Contract address
   * @param method - Either a function signature (e.g., "balanceOf(address)") or pre-encoded call data (0x...)
   * @param params - Parameters to ABI-encode (only addresses supported for simplicity)
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    let data: string

    if (method.startsWith('0x')) {
      // Already encoded call data
      data = method
    } else {
      // Build call data from function signature
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

    return this.rpc.request<string>('klay_call', [
      { to: contractAddress, data },
      'latest',
    ])
  }

  /**
   * Estimate gas for a contract call.
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

    const result = await this.rpc.request<string>('klay_estimateGas', [
      { to: contractAddress, data },
    ])

    return hexToBigInt(result).toString()
  }

  // ------- TokenCapable -------

  /**
   * Get the KIP-7 (ERC-20 compatible) token balance for an address.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    // balanceOf(address) selector
    const selector = functionSelector('balanceOf(address)')
    const data = selector + encodeAddress(address)

    const [balanceHex, decimalsHex, symbolHex] = await Promise.all([
      this.rpc.request<string>('klay_call', [{ to: tokenAddress, data }, 'latest']),
      this.rpc.request<string>('klay_call', [
        { to: tokenAddress, data: functionSelector('decimals()') },
        'latest',
      ]),
      this.rpc.request<string>('klay_call', [
        { to: tokenAddress, data: functionSelector('symbol()') },
        'latest',
      ]),
    ])

    const balance = hexToBigInt(balanceHex)
    const decimals = hexToNumber(decimalsHex)
    const symbol = decodeAbiString(symbolHex)

    return {
      address,
      amount: balance.toString(),
      symbol,
      decimals,
    }
  }

  /**
   * Get metadata for a KIP-7 (ERC-20 compatible) token.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const [nameHex, symbolHex, decimalsHex, totalSupplyHex] = await Promise.all([
      this.rpc.request<string>('klay_call', [
        { to: tokenAddress, data: functionSelector('name()') },
        'latest',
      ]),
      this.rpc.request<string>('klay_call', [
        { to: tokenAddress, data: functionSelector('symbol()') },
        'latest',
      ]),
      this.rpc.request<string>('klay_call', [
        { to: tokenAddress, data: functionSelector('decimals()') },
        'latest',
      ]),
      this.rpc.request<string>('klay_call', [
        { to: tokenAddress, data: functionSelector('totalSupply()') },
        'latest',
      ]),
    ])

    return {
      address: tokenAddress,
      name: decodeAbiString(nameHex),
      symbol: decodeAbiString(symbolHex),
      decimals: hexToNumber(decimalsHex),
      totalSupply: hexToBigInt(totalSupplyHex).toString(),
    }
  }

  /**
   * Get balances for multiple KIP-7 tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Kaia has ~1 second block time, so polls every 1 second.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const blockHex = await this.rpc.request<string>('klay_blockNumber', [])
          const blockNumber = hexToNumber(blockHex)

          if (blockNumber > lastBlockNumber) {
            lastBlockNumber = blockNumber
            callback(blockNumber)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
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
   * Polls every ~1 second (Kaia block time) and checks new blocks for matching transactions.
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
          const blockHex = await this.rpc.request<string>('klay_blockNumber', [])
          const currentBlock = hexToNumber(blockHex)

          if (currentBlock > lastBlockNumber) {
            // Check new blocks for transactions involving the address
            for (
              let blockNum = lastBlockNumber + 1;
              blockNum <= currentBlock && active;
              blockNum++
            ) {
              const block = await this.rpc.request<Record<string, unknown>>(
                'klay_getBlockByNumber',
                ['0x' + blockNum.toString(16), true],
              )

              if (block && Array.isArray(block.transactions)) {
                for (const tx of block.transactions as Record<string, string>[]) {
                  if (
                    tx.from?.toLowerCase() === normalizedAddress ||
                    tx.to?.toLowerCase() === normalizedAddress
                  ) {
                    const txInfo = await this.getTransaction(tx.hash)
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
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    }

    // Initialize lastBlockNumber
    try {
      const blockHex = await this.rpc.request<string>('klay_blockNumber', [])
      lastBlockNumber = hexToNumber(blockHex)
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
