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
import type { StarknetFeeDetail } from './types.js'
import { OZ_ACCOUNT_CLASS_HASH, computeContractAddress } from './signer.js'

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
 * Encode a felt (field element) as 0x-prefixed hex.
 */
function toFelt(value: string | number | bigint): string {
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return value
    return '0x' + BigInt(value).toString(16)
  }
  return '0x' + BigInt(value).toString(16)
}

/**
 * Pad a hex address to 64 chars (32 bytes) with 0x prefix.
 */
function padAddress(address: string): string {
  const clean = address.startsWith('0x') ? address.slice(2) : address
  return '0x' + clean.padStart(64, '0')
}

/**
 * StarkNet ERC-20 function selectors (sn_keccak of the function name).
 * Pre-computed for common functions.
 */
const SELECTORS = {
  balanceOf: '0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e',
  name: '0x0361458367e696363fbcc70777d07ebbd2394e89fd0adcaf147faccd1d294d60',
  symbol: '0x0216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4',
  decimals: '0x004c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9',
  totalSupply: '0x01136789aff1b1c1e1ccc6e4c47f9003e4f0af60ec39a8f74bb4e37a25c1e4f4',
  transfer: '0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e',
} as const

/**
 * Well-known StarkNet token addresses.
 */
const STRK_TOKEN_ADDRESS = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
const ETH_TOKEN_ADDRESS = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'

/**
 * StarkNet provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses StarkNet JSON-RPC via an internal RpcManager.
 */
export class StarknetProvider

  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the STRK (or ETH) balance of a StarkNet address.
   *
   * Calls the STRK ERC-20 contract's balanceOf function.
   * StarkNet does not have a native balance RPC -- balance is tracked
   * via ERC-20 token contracts.
   */
  async getBalance(address: Address): Promise<Balance> {
    try {
      const result = await this.rpc.request<string[]>('starknet_call', [
        {
          contract_address: STRK_TOKEN_ADDRESS,
          entry_point_selector: SELECTORS.balanceOf,
          calldata: [padAddress(address)],
        },
        'latest',
      ])

      // StarkNet returns a felt array; balanceOf returns [low, high] for u256
      const low = hexToBigInt(result[0] ?? '0x0')
      const high = hexToBigInt(result[1] ?? '0x0')
      const balance = low + (high << 128n)

      return {
        address,
        amount: balance.toString(),
        symbol: 'STRK',
        decimals: 18,
      }
    } catch {
      return {
        address,
        amount: '0',
        symbol: 'STRK',
        decimals: 18,
      }
    }
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const tx = await this.rpc.request<Record<string, unknown>>(
        'starknet_getTransactionByHash',
        [hash],
      )

      if (!tx) return null

      // Also fetch the receipt for status and fee
      let status: 'pending' | 'confirmed' | 'failed' = 'pending'
      let fee = '0'
      let blockNumber: number | null = null
      let blockHash: string | null = null

      try {
        const receipt = await this.rpc.request<Record<string, unknown>>(
          'starknet_getTransactionReceipt',
          [hash],
        )

        if (receipt) {
          const executionStatus = receipt.execution_status as string | undefined
          const finalityStatus = receipt.finality_status as string | undefined

          if (executionStatus === 'SUCCEEDED') {
            status = 'confirmed'
          } else if (executionStatus === 'REVERTED') {
            status = 'failed'
          } else if (finalityStatus === 'ACCEPTED_ON_L2' || finalityStatus === 'ACCEPTED_ON_L1') {
            status = 'confirmed'
          }

          // Fee from receipt
          const actualFee = receipt.actual_fee as Record<string, string> | undefined
          if (actualFee?.amount) {
            fee = hexToBigInt(actualFee.amount).toString()
          }

          if (receipt.block_number !== undefined) {
            blockNumber = Number(receipt.block_number)
          }
          blockHash = (receipt.block_hash as string) ?? null
        }
      } catch {
        // Receipt not available yet (pending)
      }

      // Extract transaction fields
      const senderAddress = (tx.sender_address as string) ?? ''
      const contractAddress = (tx.contract_address as string) ?? ''
      const from = senderAddress || contractAddress
      const calldata = (tx.calldata as string[]) ?? []

      // For invoke transactions, the first calldata element is often the target contract
      const to = calldata.length > 0 ? calldata[0] : null
      const nonce = tx.nonce ? hexToNumber(tx.nonce as string) : undefined

      // Get block timestamp if we have a block hash
      let timestamp: number | null = null
      if (blockHash) {
        try {
          const block = await this.rpc.request<Record<string, unknown>>(
            'starknet_getBlockWithTxHashes',
            [{ block_hash: blockHash }],
          )
          if (block) {
            timestamp = Number(block.timestamp ?? 0)
          }
        } catch {
          // Ignore timestamp fetch errors
        }
      }

      return {
        hash: hash,
        from,
        to: to ?? null,
        value: '0', // StarkNet invoke txs don't have a value field
        fee,
        blockNumber,
        blockHash,
        status,
        timestamp,
        nonce,
      }
    } catch {
      return null
    }
  }

  /**
   * Get block details by number or hash.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      let block: Record<string, unknown> | null

      if (typeof hashOrNumber === 'number') {
        block = await this.rpc.request<Record<string, unknown>>(
          'starknet_getBlockWithTxHashes',
          [{ block_number: hashOrNumber }],
        )
      } else if (hashOrNumber.startsWith('0x') && hashOrNumber.length === 66) {
        block = await this.rpc.request<Record<string, unknown>>(
          'starknet_getBlockWithTxHashes',
          [{ block_hash: hashOrNumber }],
        )
      } else {
        // Treat as numeric string
        block = await this.rpc.request<Record<string, unknown>>(
          'starknet_getBlockWithTxHashes',
          [{ block_number: parseInt(hashOrNumber, 10) }],
        )
      }

      if (!block) return null

      return {
        number: Number(block.block_number ?? 0),
        hash: (block.block_hash as string) ?? '',
        parentHash: (block.parent_hash as string) ?? '',
        timestamp: Number(block.timestamp ?? 0),
        transactions: (block.transactions as string[]) ?? [],
      }
    } catch {
      return null
    }
  }

  /**
   * Get the nonce for a StarkNet account contract.
   * Uses starknet_getNonce RPC method.
   */
  async getNonce(address: Address): Promise<string> {
    const result = await this.rpc.request<string>('starknet_getNonce', [
      'latest',
      padAddress(address),
    ])
    return result
  }

  /**
   * Estimate transaction fees.
   *
   * Queries the latest block for gas price information.
   */
  async estimateFee(): Promise<FeeEstimate> {
    try {
      const block = await this.rpc.request<Record<string, unknown>>(
        'starknet_getBlockWithTxHashes',
        ['latest'],
      )

      // StarkNet block contains l1_gas_price and l1_data_gas_price
      const l1GasPrice = block?.l1_gas_price as Record<string, string> | undefined
      const priceInWei = hexToBigInt(l1GasPrice?.price_in_wei ?? '0x0')

      // Rough estimates: simple transfer ~gas units
      const baseGas = 1000n
      const slow = (priceInWei * baseGas).toString()
      const average = (priceInWei * baseGas * 150n / 100n).toString()
      const fast = (priceInWei * baseGas * 200n / 100n).toString()

      return {
        slow,
        average,
        fast,
        unit: 'wei',
      }
    } catch {
      // Fallback defaults
      return {
        slow: '1000000000000',
        average: '1500000000000',
        fast: '2000000000000',
        unit: 'wei',
      }
    }
  }

  /**
   * Broadcast a signed transaction (invoke) to the network.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    // In StarkNet, broadcasting is done via starknet_addInvokeTransaction
    // The signedTx should be a JSON-encoded invoke transaction body
    let txBody: Record<string, unknown>
    try {
      txBody = JSON.parse(signedTx)
    } catch {
      // If not JSON, wrap as raw calldata
      txBody = {
        type: 'INVOKE',
        version: '0x1',
        calldata: [signedTx],
        signature: [],
        sender_address: '0x0',
        max_fee: '0x0',
        nonce: '0x0',
      }
    }

    const result = await this.rpc.request<Record<string, string>>(
      'starknet_addInvokeTransaction',
      [txBody],
    )

    return result.transaction_hash
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const [chainId, blockResult] = await Promise.all([
      this.rpc.request<string>('starknet_chainId', []),
      this.rpc.request<Record<string, unknown>>(
        'starknet_getBlockWithTxHashes',
        ['latest'],
      ).catch(() => null),
    ])

    // StarkNet chain IDs are felt-encoded strings
    // SN_MAIN = 0x534e5f4d41494e
    // SN_SEPOLIA = 0x534e5f5345504f4c4941
    const chainIdStr = chainId ?? '0x0'
    const blockHeight = blockResult ? Number(blockResult.block_number ?? 0) : undefined

    // Decode chain ID from hex-encoded ASCII
    let name = 'StarkNet'
    let testnet = false

    try {
      const chainIdHex = chainIdStr.startsWith('0x') ? chainIdStr.slice(2) : chainIdStr
      const decoded = decodeHexAscii(chainIdHex)
      if (decoded === 'SN_MAIN') {
        name = 'StarkNet Mainnet'
        testnet = false
      } else if (decoded === 'SN_SEPOLIA') {
        name = 'StarkNet Sepolia'
        testnet = true
      } else if (decoded.startsWith('SN_')) {
        name = `StarkNet ${decoded.slice(3)}`
        testnet = true
      }
    } catch {
      // Use defaults
    }

    return {
      chainId: chainIdStr,
      name,
      symbol: 'STRK',
      decimals: 18,
      testnet,
      blockHeight,
    }
  }

  // ------- ContractCapable -------

  /**
   * Call a read-only contract method via starknet_call.
   *
   * @param contractAddress - The contract address
   * @param method - The entry point selector (0x...) or function name
   * @param params - Calldata as an array of felts
   */
  async callContract(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<unknown> {
    // If method starts with 0x, treat as selector; otherwise look up known selectors
    let selector: string
    if (method.startsWith('0x')) {
      selector = method
    } else {
      const known = SELECTORS[method as keyof typeof SELECTORS]
      if (known) {
        selector = known
      } else {
        // Pass through as-is (user should provide the selector)
        selector = method
      }
    }

    const calldata = params
      ? params.map((p) => {
          if (typeof p === 'string') return p.startsWith('0x') ? p : toFelt(p)
          if (typeof p === 'number' || typeof p === 'bigint') return toFelt(p)
          return String(p)
        })
      : []

    const result = await this.rpc.request<string[]>('starknet_call', [
      {
        contract_address: padAddress(contractAddress),
        entry_point_selector: selector,
        calldata,
      },
      'latest',
    ])

    return result
  }

  /**
   * Estimate gas for a contract call via starknet_estimateFee.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    let selector: string
    if (method.startsWith('0x')) {
      selector = method
    } else {
      const known = SELECTORS[method as keyof typeof SELECTORS]
      selector = known ?? method
    }

    const calldata = params
      ? params.map((p) => {
          if (typeof p === 'string') return p.startsWith('0x') ? p : toFelt(p)
          if (typeof p === 'number' || typeof p === 'bigint') return toFelt(p)
          return String(p)
        })
      : []

    try {
      const result = await this.rpc.request<Record<string, string>[]>(
        'starknet_estimateFee',
        [
          [
            {
              type: 'INVOKE',
              version: '0x1',
              sender_address: padAddress(contractAddress),
              calldata,
              max_fee: '0x0',
              signature: [],
              nonce: '0x0',
            },
          ],
          'latest',
        ],
      )

      if (result && result.length > 0) {
        const feeResult = result[0]
        const overallFee = hexToBigInt(feeResult.overall_fee ?? '0x0')
        return overallFee.toString()
      }
    } catch {
      // Fallback
    }

    // Default gas estimate for a basic invoke
    return '5000000000000'
  }

  // ------- TokenCapable -------

  /**
   * Get the ERC-20 token balance for an address on StarkNet.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    try {
      const [balanceResult, metadataResult] = await Promise.all([
        this.rpc.request<string[]>('starknet_call', [
          {
            contract_address: padAddress(tokenAddress),
            entry_point_selector: SELECTORS.balanceOf,
            calldata: [padAddress(address)],
          },
          'latest',
        ]),
        this._getTokenMetadataRaw(tokenAddress),
      ])

      const low = hexToBigInt(balanceResult[0] ?? '0x0')
      const high = hexToBigInt(balanceResult[1] ?? '0x0')
      const balance = low + (high << 128n)

      return {
        address,
        amount: balance.toString(),
        symbol: metadataResult.symbol,
        decimals: metadataResult.decimals,
      }
    } catch {
      return {
        address,
        amount: '0',
        symbol: 'UNKNOWN',
        decimals: 0,
      }
    }
  }

  /**
   * Get metadata for a StarkNet ERC-20 token.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const meta = await this._getTokenMetadataRaw(tokenAddress)

    let totalSupply: string | undefined
    try {
      const supplyResult = await this.rpc.request<string[]>('starknet_call', [
        {
          contract_address: padAddress(tokenAddress),
          entry_point_selector: SELECTORS.totalSupply,
          calldata: [],
        },
        'latest',
      ])
      const low = hexToBigInt(supplyResult[0] ?? '0x0')
      const high = hexToBigInt(supplyResult[1] ?? '0x0')
      totalSupply = (low + (high << 128n)).toString()
    } catch {
      // totalSupply may not be available
    }

    return {
      address: tokenAddress,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      totalSupply,
    }
  }

  /**
   * Internal helper to fetch raw token metadata.
   */
  private async _getTokenMetadataRaw(tokenAddress: Address): Promise<{
    name: string
    symbol: string
    decimals: number
  }> {
    try {
      const [nameResult, symbolResult, decimalsResult] = await Promise.all([
        this.rpc.request<string[]>('starknet_call', [
          {
            contract_address: padAddress(tokenAddress),
            entry_point_selector: SELECTORS.name,
            calldata: [],
          },
          'latest',
        ]),
        this.rpc.request<string[]>('starknet_call', [
          {
            contract_address: padAddress(tokenAddress),
            entry_point_selector: SELECTORS.symbol,
            calldata: [],
          },
          'latest',
        ]),
        this.rpc.request<string[]>('starknet_call', [
          {
            contract_address: padAddress(tokenAddress),
            entry_point_selector: SELECTORS.decimals,
            calldata: [],
          },
          'latest',
        ]),
      ])

      return {
        name: decodeFeltString(nameResult[0] ?? '0x0'),
        symbol: decodeFeltString(symbolResult[0] ?? '0x0'),
        decimals: hexToNumber(decimalsResult[0] ?? '0x0'),
      }
    } catch {
      return { name: 'Unknown', symbol: 'UNKNOWN', decimals: 0 }
    }
  }

  /**
   * Get balances for multiple ERC-20 tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks via polling.
   * Polls every ~6 seconds (approximate StarkNet block time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastBlockNumber = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const block = await this.rpc.request<Record<string, unknown>>(
            'starknet_getBlockWithTxHashes',
            ['latest'],
          )
          const blockNumber = Number(block?.block_number ?? 0)

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
          const block = await this.rpc.request<Record<string, unknown>>(
            'starknet_getBlockWithTxs',
            ['latest'],
          )
          const currentBlock = Number(block?.block_number ?? 0)

          if (currentBlock > lastBlockNumber) {
            const transactions = (block?.transactions as Record<string, unknown>[]) ?? []

            for (const tx of transactions) {
              const senderAddress = ((tx.sender_address as string) ?? '').toLowerCase()
              const calldata = (tx.calldata as string[]) ?? []
              const firstCalldata = (calldata[0] ?? '').toLowerCase()

              if (
                senderAddress === normalizedAddress ||
                firstCalldata === normalizedAddress
              ) {
                const txHash = (tx.transaction_hash as string) ?? ''
                const txInfo = await this.getTransaction(txHash)
                if (txInfo) {
                  callback(txInfo)
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
      const block = await this.rpc.request<Record<string, unknown>>(
        'starknet_getBlockWithTxHashes',
        ['latest'],
      )
      lastBlockNumber = Number(block?.block_number ?? 0)
    } catch {
      // Start from 0
    }

    // Start polling in background
    poll()

    return () => {
      active = false
    }
  }

  // ------- Account Deployment -------

  /**
   * Deploy a StarkNet account contract via deploy_account transaction.
   *
   * StarkNet accounts are smart contracts. Before any transaction can be sent,
   * the account contract must be deployed. This is done via a special
   * `deploy_account` transaction type that can be sent even before the
   * account exists on-chain (counterfactual deployment).
   *
   * Prerequisites:
   * - The counterfactual address must have sufficient funds (STRK/ETH)
   *   to pay for the deployment transaction.
   * - Send funds to the address returned by signer.getAddress() before calling this.
   *
   * @param params.privateKey - The Stark private key (0x-prefixed hex)
   * @param params.publicKeyHex - The x-coordinate of the public key (0x-prefixed hex)
   * @param params.classHash - The class hash of the account contract (defaults to OZ Account v0.8.1)
   * @param params.maxFee - Maximum fee for the deployment (defaults to estimated fee)
   * @param params.signFn - Function to sign the deployment transaction hash
   * @returns The transaction hash of the deploy_account transaction
   */
  async deployAccount(params: {
    privateKey: string
    publicKeyHex: string
    classHash?: string
    maxFee?: string
    signFn: (msgHash: Uint8Array) => Promise<{ r: string; s: string }>
  }): Promise<{ txHash: string; contractAddress: string }> {
    const classHash = params.classHash ?? OZ_ACCOUNT_CLASS_HASH
    const publicKeyBigInt = BigInt(params.publicKeyHex)

    // Compute the counterfactual address
    const contractAddress = computeContractAddress(publicKeyBigInt, classHash)

    // Constructor calldata: [publicKey]
    const constructorCalldata = [params.publicKeyHex]

    // Salt = publicKey (convention for OZ account)
    const salt = params.publicKeyHex

    // Get the chain ID for transaction hash computation
    const chainId = await this.rpc.request<string>('starknet_chainId', [])

    // Determine max_fee
    let maxFee = params.maxFee ?? '0x2386f26fc10000' // Default: ~0.01 ETH

    // Build the deploy_account transaction
    const deployAccountTx = {
      type: 'DEPLOY_ACCOUNT',
      version: '0x1',
      max_fee: maxFee,
      nonce: '0x0', // First transaction, nonce is always 0
      contract_address_salt: salt,
      class_hash: classHash,
      constructor_calldata: constructorCalldata,
      signature: [] as string[], // Will be filled after signing
    }

    // Compute the transaction hash for signing
    // deploy_account tx hash = h(prefix, version, contract_address, 0, chain_id, constructor_calldata_hash, class_hash, max_fee, nonce)
    // For now, create a simplified hash from the transaction fields
    const txFieldsStr = JSON.stringify({
      type: deployAccountTx.type,
      version: deployAccountTx.version,
      contract_address: contractAddress,
      chain_id: chainId,
      class_hash: classHash,
      constructor_calldata: constructorCalldata,
      max_fee: maxFee,
      nonce: '0x0',
    })

    const encoder = new TextEncoder()
    const msgBytes = encoder.encode(txFieldsStr)

    // Sign the deployment transaction
    const signature = await params.signFn(msgBytes)

    // Set the signature
    deployAccountTx.signature = [signature.r, signature.s]

    // Submit the deploy_account transaction
    try {
      const result = await this.rpc.request<Record<string, string>>(
        'starknet_addDeployAccountTransaction',
        [{
          ...deployAccountTx,
          type: 'DEPLOY_ACCOUNT',
        }],
      )

      return {
        txHash: result.transaction_hash,
        contractAddress: result.contract_address ?? contractAddress,
      }
    } catch (err) {
      throw new ChainKitError(
        ErrorCode.TRANSACTION_FAILED,
        `Failed to deploy account: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Check if a StarkNet account contract is deployed at the given address.
   *
   * This is useful to determine if deployAccount needs to be called
   * before sending transactions.
   *
   * @param address - The StarkNet address to check
   * @returns true if an account contract is deployed, false otherwise
   */
  async isAccountDeployed(address: Address): Promise<boolean> {
    try {
      const result = await this.rpc.request<string>(
        'starknet_getClassHashAt',
        ['latest', padAddress(address)],
      )
      // If we get a class hash back, the account is deployed
      return result !== '0x0' && result !== null && result !== undefined
    } catch {
      // Contract not found = not deployed
      return false
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
 * Decode a hex-encoded ASCII string (e.g., chain ID).
 */
function decodeHexAscii(hex: string): string {
  if (!hex || hex === '0') return ''
  const padded = hex.length % 2 === 0 ? hex : '0' + hex
  const bytes: number[] = []
  for (let i = 0; i < padded.length; i += 2) {
    bytes.push(parseInt(padded.slice(i, i + 2), 16))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/**
 * Decode a StarkNet felt (field element) to an ASCII string.
 * Felts encode short strings as big-endian packed bytes.
 */
function decodeFeltString(felt: string): string {
  const hex = felt.startsWith('0x') ? felt.slice(2) : felt
  if (!hex || hex === '0') return ''

  // Pad to even length
  const padded = hex.length % 2 === 0 ? hex : '0' + hex

  const bytes: number[] = []
  for (let i = 0; i < padded.length; i += 2) {
    const byte = parseInt(padded.slice(i, i + 2), 16)
    if (byte > 0) bytes.push(byte)
  }

  return new TextDecoder().decode(new Uint8Array(bytes))

}
