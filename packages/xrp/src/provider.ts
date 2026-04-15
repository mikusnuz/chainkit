import {
  RpcManager,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type {
  ChainProvider,
  FeeEstimate,
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
import type { XrpFeeDetail } from './types.js'

/**
 * Parse drops (string) to XRP amount string for display.
 */
function dropsToXrp(drops: string): string {
  return (BigInt(drops) / 1000000n).toString()
}

/**
 * XRP Ledger provider implementing ChainProvider, TokenCapable,
 * and SubscriptionCapable interfaces.
 *
 * Uses rippled JSON-RPC (HTTP POST) via RpcManager.
 * rippled uses a slightly different JSON-RPC format where params is
 * a single-element array containing an object.
 */
export class XrpProvider
  implements ChainProvider, TokenCapable, SubscriptionCapable
{
  private readonly rpc: RpcManager

  constructor(config: RpcManagerConfig) {
    this.rpc = new RpcManager(config)
  }

  /**
   * Send a rippled JSON-RPC request.
   * rippled expects params as [{ ...params }] (array with one object).
   */
  private async rippledRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    // RpcManager sends standard JSON-RPC.
    // rippled expects params as a single-element array with an object.
    const rpcParams = params ? [params] : [{}]
    return this.rpc.request<T>(method, rpcParams)
  }

  // ------- ChainProvider -------

  /**
   * Get the XRP balance of an address.
   * Returns balance in drops (1 XRP = 1,000,000 drops).
   */
  async getBalance(address: Address): Promise<Balance> {
    const result = await this.rippledRequest<{
      account_data: {
        Account: string
        Balance: string
      }
    }>('account_info', {
      account: address,
      ledger_index: 'validated',
    })

    return {
      address,
      amount: result.account_data.Balance,
      symbol: 'XRP',
      decimals: 6,
    }
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const result = await this.rippledRequest<{
        Account: string
        Destination?: string
        Amount?: string | { value: string; currency: string; issuer: string }
        Fee: string
        Sequence: number
        hash: string
        inLedger?: number
        ledger_index?: number
        date?: number
        meta?: {
          TransactionResult: string
        }
        validated?: boolean
      }>('tx', { transaction: hash })

      const blockNumber = result.inLedger ?? result.ledger_index ?? null

      // Determine status
      let status: 'pending' | 'confirmed' | 'failed' = 'pending'
      if (result.validated) {
        status = result.meta?.TransactionResult === 'tesSUCCESS' ? 'confirmed' : 'failed'
      }

      // Parse amount - can be string (drops for XRP) or object (for issued currencies)
      let value = '0'
      if (typeof result.Amount === 'string') {
        value = result.Amount
      } else if (result.Amount && typeof result.Amount === 'object') {
        value = result.Amount.value
      }

      // XRP epoch starts at 2000-01-01T00:00:00Z (946684800 seconds after Unix epoch)
      const XRP_EPOCH_OFFSET = 946684800
      const timestamp = result.date ? result.date + XRP_EPOCH_OFFSET : null

      return {
        hash: result.hash,
        from: result.Account,
        to: result.Destination ?? null,
        value,
        fee: result.Fee,
        blockNumber,
        blockHash: null,
        status,
        timestamp,
        nonce: result.Sequence,
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        // Transaction not found
        return null
      }
      throw err
    }
  }

  /**
   * Get ledger (block) details by index or hash.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      const params: Record<string, unknown> = {
        transactions: true,
        expand: false,
      }

      if (typeof hashOrNumber === 'number') {
        params.ledger_index = hashOrNumber
      } else if (/^\d+$/.test(hashOrNumber)) {
        params.ledger_index = parseInt(hashOrNumber, 10)
      } else {
        params.ledger_hash = hashOrNumber
      }

      const result = await this.rippledRequest<{
        ledger: {
          ledger_index: number
          ledger_hash: string
          parent_hash: string
          close_time: number
          transactions?: string[]
        }
      }>('ledger', params)

      const XRP_EPOCH_OFFSET = 946684800

      return {
        number: result.ledger.ledger_index,
        hash: result.ledger.ledger_hash,
        parentHash: result.ledger.parent_hash,
        timestamp: result.ledger.close_time + XRP_EPOCH_OFFSET,
        transactions: result.ledger.transactions ?? [],
      }
    } catch (err) {
      if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
        return null
      }
      throw err
    }
  }

  /**
   * Estimate transaction fees using the rippled `fee` method.
   * Returns fees in drops.
   */
  async estimateFee(): Promise<FeeEstimate> {
    const result = await this.rippledRequest<{
      drops: {
        minimum_fee: string
        median_fee: string
        open_ledger_fee: string
      }
    }>('fee', {})

    const minFee = result.drops.minimum_fee
    const medianFee = result.drops.median_fee
    const openLedgerFee = result.drops.open_ledger_fee

    return {
      slow: minFee,
      average: medianFee,
      fast: openLedgerFee,
      unit: 'drops',
    }
  }

  /**
   * Broadcast a signed transaction to the network.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const txBlob = signedTx.startsWith('0x') ? signedTx.slice(2) : signedTx

    const result = await this.rippledRequest<{
      tx_json: {
        hash: string
      }
      error?: string
      engine_result?: string
      engine_result_message?: string
    }>('submit', { tx_blob: txBlob })

    if (result.error) {
      throw new ChainKitError(
        ErrorCode.TRANSACTION_FAILED,
        `Transaction submission failed: ${result.error}`,
      )
    }

    if (
      result.engine_result &&
      !result.engine_result.startsWith('tes') &&
      result.engine_result !== 'terQUEUED' &&
      !result.engine_result.startsWith('tec')
    ) {
      throw new ChainKitError(
        ErrorCode.TRANSACTION_FAILED,
        `Transaction submission failed: ${result.engine_result} - ${result.engine_result_message}`,
      )
    }

    return result.tx_json.hash
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const result = await this.rippledRequest<{
      info: {
        build_version: string
        complete_ledgers: string
        hostid: string
        server_state: string
        validated_ledger?: {
          seq: number
        }
        network_id?: number
      }
    }>('server_info', {})

    const blockHeight = result.info.validated_ledger?.seq
    const networkId = result.info.network_id

    // Determine if testnet based on network_id
    // Mainnet has no network_id or network_id=0, testnet/devnet have different IDs
    const isTestnet = networkId !== undefined && networkId !== 0

    return {
      chainId: networkId?.toString() ?? '0',
      name: isTestnet ? 'XRP Ledger Testnet' : 'XRP Ledger',
      symbol: 'XRP',
      decimals: 6,
      testnet: isTestnet,
      blockHeight,
    }
  }

  // ------- TokenCapable -------

  /**
   * Get the balance of a trustline-based token (issued currency) for an address.
   *
   * In XRP, tokenAddress is formatted as "CURRENCY:ISSUER" (e.g., "USD:rIssuerAddress").
   */
  async getTokenBalance(address: Address, tokenAddress: Address): Promise<Balance> {
    const [currency, issuer] = tokenAddress.split(':')
    if (!currency || !issuer) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Token address must be in "CURRENCY:ISSUER" format (e.g., "USD:rIssuerAddress")',
      )
    }

    const result = await this.rippledRequest<{
      lines: Array<{
        account: string
        balance: string
        currency: string
        limit: string
        limit_peer: string
      }>
    }>('account_lines', {
      account: address,
      peer: issuer,
    })

    const line = result.lines.find(
      (l) => l.currency === currency && l.account === issuer,
    )

    // IOU tokens on XRP typically use 15 significant digits, no fixed decimals
    // Convention is to use the raw value as-is
    return {
      address,
      amount: line ? line.balance : '0',
      symbol: currency,
      decimals: 15,
    }
  }

  /**
   * Get metadata for a trustline-based token.
   *
   * tokenAddress format: "CURRENCY:ISSUER"
   *
   * Note: XRP Ledger issued currencies don't have on-chain metadata like ERC-20.
   * We return what information is available from the trustline structure.
   */
  async getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const [currency, issuer] = tokenAddress.split(':')
    if (!currency || !issuer) {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'Token address must be in "CURRENCY:ISSUER" format (e.g., "USD:rIssuerAddress")',
      )
    }

    // XRP Ledger doesn't store token metadata on-chain like ERC-20
    // We provide what we can derive from the currency code and issuer
    return {
      address: tokenAddress,
      name: currency,
      symbol: currency,
      decimals: 15,
    }
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new ledgers (blocks) via polling.
   * Polls every ~4 seconds (XRP ledger close time).
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastLedgerIndex = 0
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const result = await this.rippledRequest<{
            info: {
              validated_ledger?: {
                seq: number
              }
            }
          }>('server_info', {})

          const ledgerIndex = result.info.validated_ledger?.seq ?? 0
          if (ledgerIndex > lastLedgerIndex) {
            lastLedgerIndex = ledgerIndex
            callback(ledgerIndex)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 4000))
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
   * Uses account_tx to check for new transactions.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    let lastLedgerIndex = -1
    let active = true

    // Get current ledger index as starting point
    try {
      const info = await this.rippledRequest<{
        info: {
          validated_ledger?: {
            seq: number
          }
        }
      }>('server_info', {})
      lastLedgerIndex = info.info.validated_ledger?.seq ?? -1
    } catch {
      // Start from beginning
    }

    const poll = async () => {
      while (active) {
        try {
          const result = await this.rippledRequest<{
            transactions: Array<{
              tx: {
                hash: string
                Account: string
                Destination?: string
                Amount?: string | { value: string }
                Fee: string
                Sequence: number
                date?: number
              }
              meta?: {
                TransactionResult: string
              }
              validated?: boolean
            }>
          }>('account_tx', {
            account: address,
            ledger_index_min: lastLedgerIndex > 0 ? lastLedgerIndex + 1 : -1,
            ledger_index_max: -1,
            limit: 20,
          })

          if (result.transactions && result.transactions.length > 0) {
            for (const txEntry of result.transactions) {
              const txData = txEntry.tx

              let value = '0'
              if (typeof txData.Amount === 'string') {
                value = txData.Amount
              } else if (txData.Amount && typeof txData.Amount === 'object') {
                value = txData.Amount.value
              }

              const XRP_EPOCH_OFFSET = 946684800
              const status: 'pending' | 'confirmed' | 'failed' =
                txEntry.validated
                  ? txEntry.meta?.TransactionResult === 'tesSUCCESS'
                    ? 'confirmed'
                    : 'failed'
                  : 'pending'

              callback({
                hash: txData.hash,
                from: txData.Account,
                to: txData.Destination ?? null,
                value,
                fee: txData.Fee,
                blockNumber: null,
                blockHash: null,
                status,
                timestamp: txData.date ? txData.date + XRP_EPOCH_OFFSET : null,
                nonce: txData.Sequence,
              })
            }
          }

          // Update the last ledger index
          const infoResult = await this.rippledRequest<{
            info: {
              validated_ledger?: {
                seq: number
              }
            }
          }>('server_info', {})

          const currentLedger = infoResult.info.validated_ledger?.seq ?? lastLedgerIndex
          if (currentLedger > lastLedgerIndex) {
            lastLedgerIndex = currentLedger
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, 4000))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }
}
