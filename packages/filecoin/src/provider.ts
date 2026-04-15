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
import type { FilecoinFeeDetail } from './types.js'

/**
 * Filecoin provider implementing ChainProvider, ContractCapable,
 * TokenCapable, and SubscriptionCapable interfaces.
 *
 * Uses Lotus JSON-RPC to interact with Filecoin nodes.
 */
export class FilecoinProvider
  implements ChainProvider, ContractCapable, TokenCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  // ------- ChainProvider -------

  /**
   * Get the FIL balance of an address.
   * Uses Filecoin.StateGetActor to retrieve the actor balance.
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.rpc.request<{ Balance: string } | null>(
      'Filecoin.StateGetActor',
      [address, null],
    )

    const amount = result?.Balance ?? '0'

    return {
      address,
      amount,
      symbol: 'FIL',
      decimals: 18,
    }
  }

  /**
   * Get transaction (message) details by CID hash.
   * Uses Filecoin.ChainGetMessage and Filecoin.StateSearchMsg.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    // In Filecoin, transaction lookup uses CID
    const cid = { '/': hash }

    try {
      const msg = await this.rpc.request<Record<string, unknown> | null>(
        'Filecoin.ChainGetMessage',
        [cid],
      )

      if (!msg) return null

      // Search for the message receipt to get status
      let status: 'pending' | 'confirmed' | 'failed' = 'pending'
      let blockNumber: number | null = null
      let blockHash: string | null = null
      let fee = '0'
      let timestamp: number | null = null

      try {
        const searchResult = await this.rpc.request<Record<string, unknown> | null>(
          'Filecoin.StateSearchMsg',
          [null, cid, -1, true],
        )

        if (searchResult) {
          const receipt = searchResult.Receipt as Record<string, unknown> | undefined
          if (receipt) {
            const exitCode = receipt.ExitCode as number
            status = exitCode === 0 ? 'confirmed' : 'failed'
            fee = (receipt.GasUsed as string) ?? '0'
          }

          const tipset = searchResult.TipSet as Record<string, unknown> | undefined
          if (tipset) {
            blockNumber = (searchResult.Height as number) ?? null
          }

          if (searchResult.Height != null) {
            blockNumber = searchResult.Height as number
          }
        }
      } catch {
        // Message might be pending
      }

      return {
        hash,
        from: msg.From as string,
        to: (msg.To as string) ?? null,
        value: (msg.Value as string) ?? '0',
        fee,
        blockNumber,
        blockHash,
        status,
        timestamp,
        nonce: msg.Nonce as number,
      }
    } catch {
      return null
    }
  }

  /**
   * Get block (tipset) details by height or key.
   * Uses Filecoin.ChainGetTipSetByHeight.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      let tipset: Record<string, unknown> | null

      if (typeof hashOrNumber === 'number') {
        tipset = await this.rpc.request<Record<string, unknown> | null>(
          'Filecoin.ChainGetTipSetByHeight',
          [hashOrNumber, null],
        )
      } else {
        // Treat as height string
        const height = parseInt(hashOrNumber, 10)
        if (isNaN(height)) {
          return null
        }
        tipset = await this.rpc.request<Record<string, unknown> | null>(
          'Filecoin.ChainGetTipSetByHeight',
          [height, null],
        )
      }

      if (!tipset) return null

      const cids = (tipset.Cids as Array<{ '/': string }>) ?? []
      const blocks = (tipset.Blocks as Array<Record<string, unknown>>) ?? []
      const height = (tipset.Height as number) ?? 0

      const firstBlock = blocks[0]
      const blockTimestamp = firstBlock ? (firstBlock.Timestamp as number) ?? 0 : 0
      const parentCids = firstBlock
        ? ((firstBlock.Parents as Array<{ '/': string }>) ?? [])
        : []

      return {
        number: height,
        hash: cids.length > 0 ? cids[0]['/'] : '',
        parentHash: parentCids.length > 0 ? parentCids[0]['/'] : '',
        timestamp: blockTimestamp,
        transactions: [], // Filecoin tipsets don't directly list transactions
      }
    } catch {
      return null
    }
  }

  /**
   * Get the nonce (message sequence number) for a Filecoin address.
   */
  async getNonce(address: Address): Promise<number> {
    try {
      const result = await this.rpc.request<number>('Filecoin.MpoolGetNonce', [address])
      return result
    } catch {
      return 0
    }
  }

  /**
   * Estimate transaction fees.
   * Uses Filecoin.GasEstimateMessageGas defaults for the current network.
   */
  async estimateFee(): Promise<FeeEstimate> {
    try {
      const head = await this.rpc.request<Record<string, unknown>>(
        'Filecoin.ChainHead',
        [],
      )

      // Get base fee from the chain head
      const blocks = (head.Blocks as Array<Record<string, unknown>>) ?? []
      let baseFee = 100n // default 100 attoFIL

      if (blocks.length > 0 && blocks[0].ParentBaseFee) {
        baseFee = BigInt(blocks[0].ParentBaseFee as string)
      }

      // Estimate tiers
      const slow = baseFee
      const average = (baseFee * 125n) / 100n
      const fast = (baseFee * 200n) / 100n

      // Convert from attoFIL to nanoFIL for display
      const toNanoFil = (attoFil: bigint): string => {
        const nanoFil = Number(attoFil) / 1e9
        return nanoFil.toFixed(4)
      }

      return {
        slow: toNanoFil(slow),
        average: toNanoFil(average),
        fast: toNanoFil(fast),
        unit: 'nanoFIL',
      }
    } catch {
      // Fallback defaults
      return {
        slow: '0.0001',
        average: '0.0002',
        fast: '0.0005',
        unit: 'nanoFIL',
      }
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   * Uses Filecoin.MpoolPush with the signed message.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    // The signed transaction should be a JSON-encoded SignedMessage
    // For simplicity, we pass it to MpoolPush which expects a SignedMessage object
    const signedMessage = JSON.parse(signedTx)
    const result = await this.rpc.request<{ '/': string }>(
      'Filecoin.MpoolPush',
      [signedMessage],
    )
    return result['/']
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const head = await this.rpc.request<Record<string, unknown>>(
      'Filecoin.ChainHead',
      [],
    )

    const height = (head.Height as number) ?? 0

    // Try to determine the network
    let networkName = 'Filecoin Mainnet'
    let testnet = false
    let chainId = 'filecoin'

    try {
      const name = await this.rpc.request<string>(
        'Filecoin.StateNetworkName',
        [],
      )
      if (name) {
        networkName = name
        if (name.toLowerCase().includes('calibration') || name.toLowerCase().includes('test')) {
          testnet = true
          chainId = 'filecoin-calibration'
        }
      }
    } catch {
      // Use defaults
    }

    return {
      chainId,
      name: networkName,
      symbol: 'FIL',
      decimals: 18,
      testnet,
      blockHeight: height,
    }
  }

  // ------- ContractCapable (FVM/EVM) -------

  /**
   * Call a read-only FVM/EVM contract method.
   * Uses Filecoin.EthCall for EVM-compatible calls on FEVM.
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
      // Basic ABI encoding: function selector
      const encoder = new TextEncoder()
      const hash = await this.rpc.request<string>('Filecoin.EthCall', [
        {
          to: contractAddress,
          data: method,
        },
        'latest',
      ])
      return hash
    }

    return this.rpc.request<string>('Filecoin.EthCall', [
      { to: contractAddress, data },
      'latest',
    ])
  }

  /**
   * Estimate gas for a contract call.
   * Uses Filecoin.EthEstimateGas for FEVM calls.
   */
  async estimateGas(
    contractAddress: Address,
    method: string,
    params?: unknown[],
  ): Promise<string> {
    let data: string = method.startsWith('0x') ? method : method

    const result = await this.rpc.request<string>('Filecoin.EthEstimateGas', [
      { to: contractAddress, data },
      'latest',
    ])

    // Result is hex-encoded
    if (result.startsWith('0x')) {
      return BigInt(result).toString()
    }
    return result
  }

  // ------- TokenCapable -------

  /**
   * Get the ERC-20 token balance for an address on FEVM.
   * Uses Filecoin.EthCall with balanceOf selector.
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    // balanceOf(address) selector: 0x70a08231
    const paddedAddress = address.startsWith('0x')
      ? address.slice(2).toLowerCase().padStart(64, '0')
      : address.padStart(64, '0')
    const data = '0x70a08231' + paddedAddress

    const [balanceHex, decimalsHex, symbolHex] = await Promise.all([
      this.rpc.request<string>('Filecoin.EthCall', [{ to: tokenAddress, data }, 'latest']),
      this.rpc.request<string>('Filecoin.EthCall', [
        { to: tokenAddress, data: '0x313ce567' }, // decimals()
        'latest',
      ]),
      this.rpc.request<string>('Filecoin.EthCall', [
        { to: tokenAddress, data: '0x95d89b41' }, // symbol()
        'latest',
      ]),
    ])

    const balance = balanceHex && balanceHex !== '0x' ? BigInt(balanceHex) : 0n
    const decimals = decimalsHex && decimalsHex !== '0x' ? Number(BigInt(decimalsHex)) : 18
    const symbol = decodeAbiString(symbolHex)

    return {
      address,
      amount: balance.toString(),
      symbol,
      decimals,
    }
  }

  /**
   * Get metadata for an ERC-20 token on FEVM.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const [nameHex, symbolHex, decimalsHex, totalSupplyHex] = await Promise.all([
      this.rpc.request<string>('Filecoin.EthCall', [
        { to: tokenAddress, data: '0x06fdde03' }, // name()
        'latest',
      ]),
      this.rpc.request<string>('Filecoin.EthCall', [
        { to: tokenAddress, data: '0x95d89b41' }, // symbol()
        'latest',
      ]),
      this.rpc.request<string>('Filecoin.EthCall', [
        { to: tokenAddress, data: '0x313ce567' }, // decimals()
        'latest',
      ]),
      this.rpc.request<string>('Filecoin.EthCall', [
        { to: tokenAddress, data: '0x18160ddd' }, // totalSupply()
        'latest',
      ]),
    ])

    return {
      address: tokenAddress,
      name: decodeAbiString(nameHex),
      symbol: decodeAbiString(symbolHex),
      decimals: decimalsHex && decimalsHex !== '0x' ? Number(BigInt(decimalsHex)) : 18,
      totalSupply: totalSupplyHex && totalSupplyHex !== '0x' ? BigInt(totalSupplyHex).toString() : '0',
    }
  }

  /**
   * Get balances for multiple tokens in parallel.
   */
  async getMultipleTokenBalances(address: Address, tokenAddresses: Address[]): Promise<Balance[]> {
    return Promise.all(tokenAddresses.map(t => this.getTokenBalance(address, t)))
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new blocks (tipsets) via polling.
   * Polls every ~30 seconds (Filecoin epoch time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastHeight = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const head = await this.rpc.request<Record<string, unknown>>(
            'Filecoin.ChainHead',
            [],
          )
          const height = (head.Height as number) ?? 0

          if (height > lastHeight) {
            lastHeight = height
            callback(height)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 30000))
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
   * Polls every ~30 seconds and checks the actor state for changes.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastNonce = -1
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const actor = await this.rpc.request<{ Nonce: number } | null>(
            'Filecoin.StateGetActor',
            [address, null],
          )

          if (actor && actor.Nonce > lastNonce) {
            if (lastNonce >= 0) {
              // There's been a state change - notify with minimal info
              callback({
                hash: '',
                from: address,
                to: null,
                value: '0',
                fee: '0',
                blockNumber: null,
                blockHash: null,
                status: 'confirmed',
                timestamp: null,
                nonce: actor.Nonce - 1,
              })
            }
            lastNonce = actor.Nonce
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 30000))
        }
      }
    }

    // Initialize nonce
    try {
      const actor = await this.rpc.request<{ Nonce: number } | null>(
        'Filecoin.StateGetActor',
        [address, null],
      )
      if (actor) {
        lastNonce = actor.Nonce
      }
    } catch {
      // Start fresh
    }

    poll()

    return () => {
      active = false
    }
  }
}

/**
 * Decode an ABI-encoded string (from EVM contract calls).
 */
function decodeAbiString(hex: string): string {
  if (!hex) return ''
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
