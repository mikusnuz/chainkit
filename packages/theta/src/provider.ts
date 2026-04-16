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
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'
import type { ThetaAccountResult, ThetaBlockResult } from './types.js'

/**
 * Compute the 4-byte function selector from a function signature.
 * e.g., "balanceOf(address)" -> "0x70a08231"
 */
function functionSelector(signature: string): string {
  const hash = keccak_256(new TextEncoder().encode(signature))
  return '0x' + bytesToHex(hash).slice(0, 8)
}

/**
 * ABI-encode an Ethereum address as a 32-byte padded value.
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

  // Read offset (first 32 bytes)
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
 * Theta provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses Theta JSON-RPC (theta.GetAccount, theta.GetBlock, theta.BroadcastRawTransaction)
 * for native operations, and falls back to EVM-compatible eth_* RPC for
 * contract interactions (since Theta is EVM-compatible).
 */
export class ThetaProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the THETA balance of an address.
   * Theta's theta.GetAccount returns both THETA and TFUEL balances.
   * This method returns the THETA balance by default.
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.rpc.request<ThetaAccountResult>('theta.GetAccount', [
      { address },
    ])

    const thetawei = BigInt(result?.coins?.thetawei ?? '0')

    return {
      address,
      amount: thetawei.toString(),
      symbol: 'THETA',
      decimals: 18,
    }
  }

  /**
   * Get the TFUEL balance of an address.
   * Convenience method specific to Theta chain.
   */
  async getTfuelBalance(address: Address): Promise<Balance> {
    const result = await this.rpc.request<ThetaAccountResult>('theta.GetAccount', [
      { address },
    ])

    const tfuelwei = BigInt(result?.coins?.tfuelwei ?? '0')

    return {
      address,
      amount: tfuelwei.toString(),
      symbol: 'TFUEL',
      decimals: 18,
    }
  }

  /**
   * Get transaction details by hash.
   * Uses eth_getTransactionByHash via the EVM-compatible RPC endpoint.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    const tx = await this.rpc.request<Record<string, string> | null>(
      'eth_getTransactionByHash',
      [hash],
    )

    if (!tx) return null

    // Fetch receipt for status
    let status: 'pending' | 'confirmed' | 'failed' = 'pending'
    let fee = '0'
    if (tx.blockNumber) {
      const receipt = await this.rpc.request<Record<string, string> | null>(
        'eth_getTransactionReceipt',
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
        'eth_getBlockByHash',
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
   * Uses theta.GetBlock for Theta-native block retrieval.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    let blockHeight: string

    if (typeof hashOrNumber === 'number') {
      blockHeight = hashOrNumber.toString()
    } else if (hashOrNumber.startsWith('0x') && hashOrNumber.length === 66) {
      // Block hash - use EVM-compatible RPC for hash-based lookup
      const block = await this.rpc.request<Record<string, unknown> | null>(
        'eth_getBlockByHash',
        [hashOrNumber, false],
      )
      if (!block) return null
      return {
        number: hexToNumber(block.number as string),
        hash: block.hash as string,
        parentHash: block.parentHash as string,
        timestamp: hexToNumber(block.timestamp as string),
        transactions: (block.transactions as string[]) ?? [],
      }
    } else {
      blockHeight = hashOrNumber
    }

    const result = await this.rpc.request<ThetaBlockResult | null>('theta.GetBlock', [
      { height: blockHeight },
    ])

    if (!result) return null

    const txHashes = (result.transactions ?? []).map((tx) => tx.hash)

    return {
      number: parseInt(result.height, 10),
      hash: result.hash,
      parentHash: result.parent,
      timestamp: parseInt(result.timestamp, 10),
      transactions: txHashes,
    }
  }

  /**
   * Get the transaction count (nonce) for an address.
   * Uses eth_getTransactionCount since Theta is EVM-compatible.
   */
  async getNonce(address: Address): Promise<number> {
    const result = await this.rpc.request<string>('eth_getTransactionCount', [address, 'latest'])
    return hexToNumber(result)
  }

  /**
   * Estimate transaction fees.
   * Theta has a fixed minimum TFUEL fee for transactions.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Theta uses a fixed gas price model with TFUEL as gas
    // Minimum gas price is typically 4000 TFuelWei (0.000000000000004 TFUEL)
    // Try to get current gas price from the EVM RPC
    let gasPrice: bigint
    try {
      const gasPriceHex = await this.rpc.request<string>('eth_gasPrice', [])
      gasPrice = hexToBigInt(gasPriceHex)
    } catch {
      // Fallback to Theta's default minimum gas price: 4000 TFuelWei
      gasPrice = 4000n
    }

    const toGwei = (wei: bigint) => {
      const gwei = Number(wei) / 1e9
      return gwei.toFixed(6)
    }

    return {
      slow: toGwei(gasPrice),
      average: toGwei(gasPrice),
      fast: toGwei(gasPrice * 2n),
      unit: 'gwei',
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   * Uses theta.BroadcastRawTransaction for native Theta transactions,
   * with fallback to eth_sendRawTransaction for EVM transactions.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    try {
      const result = await this.rpc.request<{ hash: string } | string>(
        'theta.BroadcastRawTransaction',
        [{ tx_bytes: signedTx }],
      )
      if (typeof result === 'object' && result !== null && 'hash' in result) {
        return result.hash
      }
      return result as string
    } catch {
      // Fallback to EVM-compatible RPC
      return this.rpc.request<string>('eth_sendRawTransaction', [signedTx])
    }
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    // Try to get status from Theta RPC
    let blockHeight = 0
    let chainId = '361' // Theta mainnet
    let testnet = false

    try {
      const [chainIdHex, blockNumberHex] = await Promise.all([
        this.rpc.request<string>('eth_chainId', []),
        this.rpc.request<string>('eth_blockNumber', []),
      ])
      const chainIdNum = hexToNumber(chainIdHex)
      chainId = chainIdNum.toString()
      blockHeight = hexToNumber(blockNumberHex)

      // Known Theta chain IDs
      if (chainIdNum === 365) {
        testnet = true
      }
    } catch {
      // Use defaults
    }

    const name = testnet ? 'Theta Testnet' : 'Theta Mainnet'

    return {
      chainId,
      name,
      symbol: 'THETA',
      decimals: 18,
      testnet,
      blockHeight,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only contract method.
   * Uses EVM-compatible eth_call since Theta supports EVM smart contracts.
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

    return this.rpc.request<string>('eth_call', [
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

    const result = await this.rpc.request<string>('eth_estimateGas', [
      { to: contractAddress, data },
    ])

    return hexToBigInt(result).toString()
  }

  // ------- TokenCapable -------

  /**
   * Get the TNT-20 token balance for an address.
   * TNT-20 is Theta's ERC-20 equivalent.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    // balanceOf(address) selector
    const selector = functionSelector('balanceOf(address)')
    const data = selector + encodeAddress(address)

    const [balanceHex, decimalsHex, symbolHex] = await Promise.all([
      this.rpc.request<string>('eth_call', [{ to: tokenAddress, data }, 'latest']),
      this.rpc.request<string>('eth_call', [
        { to: tokenAddress, data: functionSelector('decimals()') },
        'latest',
      ]),
      this.rpc.request<string>('eth_call', [
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
   * Get metadata for a TNT-20 token.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const [nameHex, symbolHex, decimalsHex, totalSupplyHex] = await Promise.all([
      this.rpc.request<string>('eth_call', [
        { to: tokenAddress, data: functionSelector('name()') },
        'latest',
      ]),
      this.rpc.request<string>('eth_call', [
        { to: tokenAddress, data: functionSelector('symbol()') },
        'latest',
      ]),
      this.rpc.request<string>('eth_call', [
        { to: tokenAddress, data: functionSelector('decimals()') },
        'latest',
      ]),
      this.rpc.request<string>('eth_call', [
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
   * Get balances for multiple TNT-20 tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Polls every ~6 seconds (Theta's block time is ~6 seconds).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const blockHex = await this.rpc.request<string>('eth_blockNumber', [])
          const blockNumber = hexToNumber(blockHex)

          if (blockNumber > lastBlockNumber) {
            lastBlockNumber = blockNumber
            callback(blockNumber)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 6000))
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
   * Polls every ~6 seconds and checks new blocks for matching transactions.
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
          const blockHex = await this.rpc.request<string>('eth_blockNumber', [])
          const currentBlock = hexToNumber(blockHex)

          if (currentBlock > lastBlockNumber) {
            // Check new blocks for transactions involving the address
            for (
              let blockNum = lastBlockNumber + 1;
              blockNum <= currentBlock && active;
              blockNum++
            ) {
              const block = await this.rpc.request<Record<string, unknown>>(
                'eth_getBlockByNumber',
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
          await new Promise((resolve) => setTimeout(resolve, 6000))
        }
      }
    }

    // Initialize lastBlockNumber
    try {
      const blockHex = await this.rpc.request<string>('eth_blockNumber', [])
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
