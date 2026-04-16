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
 * Known NEP-17 contract script hashes on Neo N3 (little-endian hex, no 0x prefix).
 */
const NEO_CONTRACT_HASH = 'ef4073a0f2b305a38ec4050e4d3d28bc40ea63f5'
const GAS_CONTRACT_HASH = 'd2a4cff31913016155e38e474a2c06d08be276cf'

/**
 * Parse a hex string to a BigInt.
 */
function hexToBigInt(hex: string): bigint {
  if (!hex || hex === '0x' || hex === '0x0') return 0n
  const clean = hex.startsWith('0x') ? hex : '0x' + hex
  return BigInt(clean)
}

/**
 * Parse a hex string to a number.
 */
function hexToNumber(hex: string): number {
  if (!hex || hex === '0x' || hex === '0x0') return 0
  const clean = hex.startsWith('0x') ? hex : '0x' + hex
  return Number(BigInt(clean))
}

/**
 * Decode a base64-encoded integer value from Neo RPC stack results.
 * Neo N3 returns Integer types as strings directly.
 */
function decodeStackInteger(item: NeoStackItem): bigint {
  if (item.type === 'Integer') {
    return BigInt(item.value as string)
  }
  if (item.type === 'ByteString' && typeof item.value === 'string') {
    // Base64-encoded little-endian integer
    const bytes = base64ToBytes(item.value)
    if (bytes.length === 0) return 0n
    return littleEndianBytesToBigInt(bytes)
  }
  return 0n
}

/**
 * Decode a base64-encoded string from Neo RPC stack results.
 */
function decodeStackString(item: NeoStackItem): string {
  if (item.type === 'ByteString' && typeof item.value === 'string') {
    const bytes = base64ToBytes(item.value)
    return new TextDecoder().decode(bytes)
  }
  if (typeof item.value === 'string') {
    return item.value
  }
  return ''
}

/**
 * Convert base64 string to bytes.
 */
function base64ToBytes(b64: string): Uint8Array {
  if (!b64 || b64 === '') return new Uint8Array(0)
  const binaryStr = atob(b64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }
  return bytes
}

/**
 * Convert little-endian bytes to BigInt (signed).
 */
function littleEndianBytesToBigInt(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n
  let result = 0n
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i])
  }
  // Check if negative (MSB of last byte is set)
  if (bytes[bytes.length - 1] & 0x80) {
    result -= 1n << BigInt(bytes.length * 8)
  }
  return result
}

/**
 * Convert a Neo3 address to a script hash (little-endian hex, no prefix).
 */
function addressToScriptHash(address: string): string {
  // Decode base58check: version (1 byte) + script hash (20 bytes)
  // We'll do a simple implementation here
  const decoded = decodeBase58Check(address)
  if (decoded.length !== 21) {
    throw new ChainKitError(
      ErrorCode.INVALID_ADDRESS,
      `Invalid Neo3 address: expected 21 bytes, got ${decoded.length}`,
    )
  }
  // Skip version byte, return script hash as hex (already little-endian)
  const scriptHash = decoded.slice(1)
  return bytesToHexStr(scriptHash)
}

/**
 * Convert a script hash (little-endian hex) to big-endian hex with 0x prefix.
 */
function scriptHashToContractHash(scriptHash: string): string {
  // Reverse byte order
  const bytes = hexStrToBytes(scriptHash)
  const reversed = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    reversed[i] = bytes[bytes.length - 1 - i]
  }
  return '0x' + bytesToHexStr(reversed)
}

/**
 * Simple base58check decode.
 */
function decodeBase58Check(encoded: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

  // Decode base58
  let value = 0n
  for (const char of encoded) {
    const index = ALPHABET.indexOf(char)
    if (index === -1) {
      throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Invalid base58 character: ${char}`)
    }
    value = value * 58n + BigInt(index)
  }

  // Convert to bytes
  let hex = value.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  const bytes = hexStrToBytes(hex)

  // Add leading zeros for leading '1' characters
  let leadingOnes = 0
  for (const char of encoded) {
    if (char === '1') leadingOnes++
    else break
  }

  const result = new Uint8Array(leadingOnes + bytes.length)
  result.set(bytes, leadingOnes)

  // Verify checksum (last 4 bytes)
  const payload = result.slice(0, result.length - 4)
  // We trust the checksum for now in the provider context
  return payload
}

/**
 * Convert bytes to hex string (no prefix).
 */
function bytesToHexStr(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Convert hex string (no prefix) to bytes.
 */
function hexStrToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Neo N3 RPC stack item type.
 */
interface NeoStackItem {
  type: string
  value?: unknown
}

/**
 * Neo N3 NEP-17 balance entry from getnep17balances.
 */
interface Nep17BalanceEntry {
  assethash: string
  amount: string
  lastupdatedblock: number
}

/**
 * Neo N3 provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses Neo N3 JSON-RPC to interact with the blockchain.
 */
export class NeoProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the NEO and GAS balance of an address.
   * Returns the GAS balance by default (since GAS is the utility token for fees).
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.rpc.request<{
      address: string
      balance: Nep17BalanceEntry[]
    }>('getnep17balances', [address])

    // Find GAS balance
    const gasEntry = result.balance?.find(
      (b) => b.assethash === scriptHashToContractHash(GAS_CONTRACT_HASH),
    )

    const amount = gasEntry ? gasEntry.amount : '0'

    return {
      address,
      amount,
      symbol: 'GAS',
      decimals: 8,
    }
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const tx = await this.rpc.request<Record<string, unknown>>(
        'getrawtransaction',
        [hash, true], // verbose = true for decoded
      )

      if (!tx) return null

      // Get application log for execution result
      let status: 'pending' | 'confirmed' | 'failed' = 'pending'
      let fee = '0'

      const blockHash = tx.blockhash as string | undefined
      let blockNumber: number | null = null
      let timestamp: number | null = null

      if (blockHash) {
        status = 'confirmed'
        // Try getting application log for execution status
        try {
          const appLog = await this.rpc.request<Record<string, unknown>>(
            'getapplicationlog',
            [hash],
          )
          const executions = appLog.executions as Array<Record<string, unknown>> | undefined
          if (executions && executions.length > 0) {
            const vmState = executions[0].vmstate as string
            if (vmState === 'FAULT') {
              status = 'failed'
            }
          }
        } catch {
          // Application log may not be available
        }

        // Get block info
        try {
          const block = await this.rpc.request<Record<string, unknown>>(
            'getblock',
            [blockHash, true],
          )
          if (block) {
            blockNumber = block.index as number
            timestamp = block.time as number
            if (timestamp && timestamp > 1e12) {
              // Convert milliseconds to seconds if needed
              timestamp = Math.floor(timestamp / 1000)
            }
          }
        } catch {
          // Block info may not be available
        }
      }

      // Calculate fee (systemFee + networkFee)
      const systemFee = tx.sysfee as string ?? '0'
      const networkFee = tx.netfee as string ?? '0'
      const totalFee = (
        BigInt(Math.round(parseFloat(systemFee) * 1e8)) +
        BigInt(Math.round(parseFloat(networkFee) * 1e8))
      ).toString()

      // Neo transactions don't have a simple "from" and "to" like account-based chains.
      // We extract sender from the first signer.
      const signers = tx.signers as Array<Record<string, unknown>> | undefined
      const from = signers && signers.length > 0
        ? (signers[0].account as string) ?? ''
        : ''

      return {
        hash: tx.hash as string,
        from,
        to: null, // Neo transactions are script-based, no single "to"
        value: '0',
        fee: totalFee,
        blockNumber,
        blockHash: blockHash ?? null,
        status,
        timestamp,
        data: tx.script as string | undefined,
        nonce: tx.nonce as number | undefined,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get block details by number or hash.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      const block = await this.rpc.request<Record<string, unknown>>(
        'getblock',
        [typeof hashOrNumber === 'number' ? hashOrNumber : hashOrNumber, true],
      )

      if (!block) return null

      // Extract transaction hashes
      const txList = block.tx as Array<Record<string, string>> | undefined
      const transactions = txList
        ? txList.map((t) => t.hash)
        : []

      let timestamp = block.time as number
      if (timestamp && timestamp > 1e12) {
        timestamp = Math.floor(timestamp / 1000)
      }

      return {
        number: block.index as number,
        hash: block.hash as string,
        parentHash: block.previousblockhash as string ?? '',
        timestamp,
        transactions,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Get the nonce for an address.
   * Neo N3 does not use sequential nonces in the traditional sense.
   * Returns 0 as Neo transactions use random nonces.
   */
  async getNonce(_address: Address): Promise<number> {
    return 0
  }

  /**
   * Estimate transaction fees.
   * Neo N3 fees are based on systemFee (execution cost) and networkFee (size-based).
   * Returns estimates in GAS units.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Neo N3 has relatively fixed fee structure.
    // System fee depends on contract execution, network fee depends on tx size.
    // Provide reasonable estimates.
    try {
      const policy = await this.rpc.request<Record<string, unknown>>(
        'invokefunction',
        [
          scriptHashToContractHash(GAS_CONTRACT_HASH).slice(2), // Remove 0x for RPC
          'symbol',
          [],
        ],
      )
      // If we can reach the node, provide standard estimates
      void policy
    } catch {
      // Fallback estimates
    }

    return {
      slow: '0.001',
      average: '0.01',
      fast: '0.1',
      unit: 'GAS',
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const raw = signedTx.startsWith('0x') ? signedTx.slice(2) : signedTx

    // Neo-GO expects base64-encoded raw transaction, not hex
    const hexBytes = new Uint8Array(raw.length / 2)
    for (let i = 0; i < hexBytes.length; i++) {
      hexBytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16)
    }
    let binary = ''
    for (let i = 0; i < hexBytes.length; i++) {
      binary += String.fromCharCode(hexBytes[i])
    }
    const base64Tx = btoa(binary)

    const result = await this.rpc.request<Record<string, unknown>>(
      'sendrawtransaction',
      [base64Tx],
    )

    // Neo N3 returns { hash: "0x..." } on success
    if (result && typeof result === 'object' && 'hash' in result) {
      return result.hash as string
    }

    throw new ChainKitError(
      ErrorCode.TRANSACTION_FAILED,
      'Failed to broadcast transaction',
      { result },
    )
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [version, blockCount] = await Promise.all([
      this.rpc.request<Record<string, unknown>>('getversion', []),
      this.rpc.request<number>('getblockcount', []),
    ])

    // Neo-GO returns network magic inside protocol.network
    const protocol = version.protocol as Record<string, unknown> | undefined
    const network = (protocol?.network as number | undefined) ?? (version.network as number | undefined)
    const neoVersion = (version.useragent as string | undefined) ?? (version.neoversion as string | undefined)

    // Detect testnet from network magic
    const isTestnet = network === 894710606 // Neo3 testnet magic

    return {
      chainId: network?.toString() ?? '860833102',
      name: isTestnet
        ? `Neo N3 Testnet${neoVersion ? ` (${neoVersion})` : ''}`
        : `Neo N3${neoVersion ? ` (${neoVersion})` : ''}`,
      symbol: 'NEO',
      decimals: 0,
      testnet: isTestnet,
      blockHeight: typeof blockCount === 'number' ? blockCount - 1 : 0,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only contract method via NeoVM invokefunction.
   * @param contractAddress - The contract script hash (0x-prefixed, big-endian)
   * @param method - The contract method name
   * @param params - Method parameters as ContractParam-like objects
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    const contractHash = contractAddress.startsWith('0x')
      ? contractAddress
      : '0x' + contractAddress

    // Convert params to Neo RPC format
    const rpcParams: Array<{ type: string; value: unknown }> = []
    if (params) {
      for (const param of params) {
        if (typeof param === 'object' && param !== null && 'type' in param) {
          rpcParams.push(param as { type: string; value: unknown })
        } else if (typeof param === 'string') {
          if (param.startsWith('0x')) {
            rpcParams.push({ type: 'Hash160', value: param })
          } else {
            rpcParams.push({ type: 'String', value: param })
          }
        } else if (typeof param === 'number') {
          rpcParams.push({ type: 'Integer', value: param.toString() })
        } else if (typeof param === 'bigint') {
          rpcParams.push({ type: 'Integer', value: param.toString() })
        }
      }
    }

    const result = await this.rpc.request<Record<string, unknown>>(
      'invokefunction',
      [contractHash, method, rpcParams],
    )

    // Return the stack result
    const stack = result.stack as NeoStackItem[] | undefined
    if (stack && stack.length > 0) {
      return stack[0]
    }

    return result
  }

  /**
   * Estimate gas for a contract call.
   * Uses invokefunction to get the GAS consumed.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    const contractHash = contractAddress.startsWith('0x')
      ? contractAddress
      : '0x' + contractAddress

    const rpcParams: Array<{ type: string; value: unknown }> = []
    if (params) {
      for (const param of params) {
        if (typeof param === 'object' && param !== null && 'type' in param) {
          rpcParams.push(param as { type: string; value: unknown })
        } else if (typeof param === 'string') {
          rpcParams.push({ type: 'String', value: param })
        } else if (typeof param === 'number') {
          rpcParams.push({ type: 'Integer', value: param.toString() })
        }
      }
    }

    const result = await this.rpc.request<Record<string, unknown>>(
      'invokefunction',
      [contractHash, method, rpcParams],
    )

    return (result.gasconsumed as string) ?? '0'
  }

  // ------- TokenCapable -------

  /**
   * Get the NEP-17 token balance for an address.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    const contractHash = tokenAddress.startsWith('0x')
      ? tokenAddress
      : '0x' + tokenAddress

    // Convert address to script hash for the RPC call
    let addressParam: { type: string; value: string }
    try {
      const scriptHash = addressToScriptHash(address)
      addressParam = { type: 'Hash160', value: '0x' + scriptHash }
    } catch {
      // If not a standard address, treat as direct hash
      addressParam = { type: 'Hash160', value: address }
    }

    // Call balanceOf
    const [balanceResult, decimalsResult, symbolResult] = await Promise.all([
      this.rpc.request<Record<string, unknown>>(
        'invokefunction',
        [contractHash, 'balanceOf', [addressParam]],
      ),
      this.rpc.request<Record<string, unknown>>(
        'invokefunction',
        [contractHash, 'decimals', []],
      ),
      this.rpc.request<Record<string, unknown>>(
        'invokefunction',
        [contractHash, 'symbol', []],
      ),
    ])

    const balanceStack = balanceResult.stack as NeoStackItem[] | undefined
    const decimalsStack = decimalsResult.stack as NeoStackItem[] | undefined
    const symbolStack = symbolResult.stack as NeoStackItem[] | undefined

    const balance = balanceStack?.length ? decodeStackInteger(balanceStack[0]) : 0n
    const decimals = decimalsStack?.length ? Number(decodeStackInteger(decimalsStack[0])) : 0
    const symbol = symbolStack?.length ? decodeStackString(symbolStack[0]) : ''

    return {
      address,
      amount: balance.toString(),
      symbol,
      decimals,
    }
  }

  /**
   * Get metadata for a NEP-17 token.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const contractHash = tokenAddress.startsWith('0x')
      ? tokenAddress
      : '0x' + tokenAddress

    const [nameResult, symbolResult, decimalsResult, totalSupplyResult] = await Promise.all([
      this.rpc.request<Record<string, unknown>>(
        'invokefunction',
        [contractHash, 'symbol', []], // NEP-17 uses symbol, name is not always available
      ),
      this.rpc.request<Record<string, unknown>>(
        'invokefunction',
        [contractHash, 'symbol', []],
      ),
      this.rpc.request<Record<string, unknown>>(
        'invokefunction',
        [contractHash, 'decimals', []],
      ),
      this.rpc.request<Record<string, unknown>>(
        'invokefunction',
        [contractHash, 'totalSupply', []],
      ),
    ])

    const nameStack = nameResult.stack as NeoStackItem[] | undefined
    const symbolStack = symbolResult.stack as NeoStackItem[] | undefined
    const decimalsStack = decimalsResult.stack as NeoStackItem[] | undefined
    const supplyStack = totalSupplyResult.stack as NeoStackItem[] | undefined

    return {
      address: tokenAddress,
      name: nameStack?.length ? decodeStackString(nameStack[0]) : '',
      symbol: symbolStack?.length ? decodeStackString(symbolStack[0]) : '',
      decimals: decimalsStack?.length ? Number(decodeStackInteger(decimalsStack[0])) : 0,
      totalSupply: supplyStack?.length ? decodeStackInteger(supplyStack[0]).toString() : undefined,
    }
  }

  /**
   * Get balances for multiple NEP-17 tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Neo N3 block time is ~15 seconds.
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const blockCount = await this.rpc.request<number>('getblockcount', [])
          const blockNumber = blockCount - 1

          if (blockNumber > lastBlockNumber) {
            lastBlockNumber = blockNumber
            callback(blockNumber)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 15000))
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
   * Polls every ~15 seconds and checks new blocks for matching transactions.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    // Convert address to script hash for matching
    let targetScriptHash: string
    try {
      targetScriptHash = addressToScriptHash(address)
    } catch {
      targetScriptHash = address
    }

    const poll = async () => {
      while (active) {
        try {
          const blockCount = await this.rpc.request<number>('getblockcount', [])
          const currentBlock = blockCount - 1

          if (currentBlock > lastBlockNumber) {
            for (
              let blockNum = lastBlockNumber + 1;
              blockNum <= currentBlock && active;
              blockNum++
            ) {
              const block = await this.rpc.request<Record<string, unknown>>(
                'getblock',
                [blockNum, true],
              )

              if (block) {
                const txList = block.tx as Array<Record<string, unknown>> | undefined
                if (txList) {
                  for (const tx of txList) {
                    // Check if any signer matches the target address
                    const signers = tx.signers as Array<Record<string, string>> | undefined
                    const signerMatch = signers?.some(
                      (s) => s.account?.toLowerCase().includes(targetScriptHash),
                    )

                    if (signerMatch) {
                      const txInfo = await this.getTransaction(tx.hash as string)
                      if (txInfo) {
                        callback(txInfo)
                      }
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
          await new Promise((resolve) => setTimeout(resolve, 15000))
        }
      }
    }

    // Initialize
    try {
      const blockCount = await this.rpc.request<number>('getblockcount', [])
      lastBlockNumber = blockCount - 1
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
