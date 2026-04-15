import {
  RpcManager,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type {
  ChainProvider,
  FeeEstimate,
  SubscriptionCapable,
  Address,
  TxHash,
  Balance,
  TransactionInfo,
  BlockInfo,
  ChainInfo,
  HexString,
  Unsubscribe,
  RpcManagerConfig,
} from '@chainkit/core'
import type { NostrEvent } from './types.js'
import { decodeBech32 } from './signer.js'

/**
 * Configuration for the Nostr provider.
 * Extends RpcManagerConfig — endpoints should be HTTP relay endpoints
 * (e.g., https://relay.damus.io for HTTP-based access).
 */
export interface NostrProviderConfig extends RpcManagerConfig {
  /** Polling interval in ms for subscriptions (default: 30000) */
  pollInterval?: number
}

/**
 * Normalize an npub address to a hex pubkey.
 * Accepts npub bech32, 0x-prefixed hex, or raw hex.
 */
function normalizeAddress(address: string): string {
  if (address.startsWith('npub1') && address.length > 10) {
    try {
      const decoded = decodeBech32(address)
      if (decoded.prefix !== 'npub') {
        throw new ChainKitError(
          ErrorCode.INVALID_ADDRESS,
          `Expected npub prefix, got: ${decoded.prefix}`,
        )
      }
      return decoded.hex
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        `Invalid npub address: ${(err as Error).message}`,
      )
    }
  }
  return address.startsWith('0x') ? address.slice(2) : address
}

/**
 * Nostr provider implementing ChainProvider and SubscriptionCapable.
 *
 * Nostr is a relay-based protocol, not a traditional blockchain.
 * This provider adapts the ChainProvider interface to work with
 * Nostr relay HTTP endpoints (NIP-11 / NIP-50 compatible).
 *
 * Many blockchain concepts (blocks, gas fees, etc.) don't directly
 * apply to Nostr. This implementation provides sensible defaults
 * and maps Nostr concepts where possible.
 */
export class NostrProvider implements ChainProvider, SubscriptionCapable {
  private readonly rpc: RpcManager
  private readonly pollInterval: number

  constructor(config: NostrProviderConfig) {
    this.rpc = new RpcManager(config)
    this.pollInterval = config.pollInterval ?? 30000
  }

  // ------- ChainProvider -------

  /**
   * Get the balance of an address.
   * Queries the relay for kind 9735 (zap receipt) events to approximate balance.
   * In Nostr Assets, balance is derived from asset-transfer events.
   */
  async getBalance(address: Address): Promise<Balance> {
    const pubkey = normalizeAddress(address)

    try {
      // Query relay for balance-related events (kind 37375 = asset balance)
      const result = await this.rpc.request<{ balance?: string } | null>(
        'nostr_getBalance',
        [pubkey],
      )

      return {
        address,
        amount: result?.balance ?? '0',
        symbol: 'SAT',
        decimals: 0,
      }
    } catch {
      // Relay may not support balance queries — return zero
      return {
        address,
        amount: '0',
        symbol: 'SAT',
        decimals: 0,
      }
    }
  }

  /**
   * Get a Nostr event by its ID.
   * Maps the event to TransactionInfo format.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    try {
      const event = await this.rpc.request<NostrEvent | null>(
        'nostr_getEvent',
        [hash],
      )

      if (!event) return null

      // Extract sender/receiver from event tags
      const pTags = event.tags.filter((t) => t[0] === 'p')
      const recipient = pTags.length > 0 ? pTags[0][1] : null

      // Extract amount from tags if present (e.g., "amount" tag)
      const amountTag = event.tags.find((t) => t[0] === 'amount')
      const amount = amountTag ? amountTag[1] : '0'

      return {
        hash: event.id,
        from: event.pubkey,
        to: recipient,
        value: amount,
        fee: '0',
        blockNumber: null, // Nostr has no blocks
        blockHash: null,
        status: 'confirmed',
        timestamp: event.created_at,
        data: event.content || undefined,
        nonce: undefined,
      }
    } catch {
      return null
    }
  }

  /**
   * Get block information.
   * Nostr does not have blocks — returns relay metadata as a pseudo-block.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    try {
      // Query relay info (NIP-11)
      const relayInfo = await this.rpc.request<{
        name?: string
        description?: string
        supported_nips?: number[]
      }>('nostr_getRelayInfo', [])

      return {
        number: typeof hashOrNumber === 'number' ? hashOrNumber : 0,
        hash: typeof hashOrNumber === 'string' ? hashOrNumber : '0',
        parentHash: '0',
        timestamp: Math.floor(Date.now() / 1000),
        transactions: [],
      }
    } catch {
      return null
    }
  }

  /**
   * Estimate fees.
   * Nostr relays typically have zero or minimal fees.
   */
  async estimateFee(): Promise<FeeEstimate> {
    return {
      slow: '0',
      average: '0',
      fast: '0',
      unit: 'sat',
    }
  }

  /**
   * Broadcast a signed event to the relay.
   * The signedTx should be a JSON string of a signed Nostr event.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    let event: NostrEvent

    try {
      event = JSON.parse(signedTx) as NostrEvent
    } catch {
      throw new ChainKitError(
        ErrorCode.INVALID_PARAMS,
        'signedTx must be a JSON-encoded Nostr event',
      )
    }

    try {
      // Standard NIP-20 command result: ["OK", event_id, success, message]
      const result = await this.rpc.request<string | string[]>(
        'nostr_publishEvent',
        [event],
      )

      // Return the event ID as the "transaction hash"
      return event.id
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      throw new ChainKitError(
        ErrorCode.TRANSACTION_FAILED,
        `Failed to publish event: ${(err as Error).message}`,
      )
    }
  }

  /**
   * Get chain/network information.
   * Returns Nostr relay metadata.
   */
  async getChainInfo(): Promise<ChainInfo> {
    try {
      const relayInfo = await this.rpc.request<{
        name?: string
        description?: string
        supported_nips?: number[]
      }>('nostr_getRelayInfo', [])

      return {
        chainId: 'nostr',
        name: relayInfo?.name ?? 'Nostr Relay',
        symbol: 'SAT',
        decimals: 0,
        testnet: false,
      }
    } catch {
      return {
        chainId: 'nostr',
        name: 'Nostr Relay',
        symbol: 'SAT',
        decimals: 0,
        testnet: false,
      }
    }
  }

  // ------- SubscriptionCapable -------

  /**
   * Subscribe to new events via polling.
   * In Nostr, there are no blocks — this polls for new events and
   * reports the latest event timestamp as a pseudo "block number".
   */
  async subscribeBlocks(
    callback: (blockNumber: number) => void,
  ): Promise<Unsubscribe> {
    let lastTimestamp = Math.floor(Date.now() / 1000)
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const result = await this.rpc.request<{ latest_timestamp?: number } | null>(
            'nostr_getLatestEvents',
            [{ since: lastTimestamp, limit: 1 }],
          )

          if (result?.latest_timestamp && result.latest_timestamp > lastTimestamp) {
            lastTimestamp = result.latest_timestamp
            callback(lastTimestamp)
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, this.pollInterval))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }

  /**
   * Subscribe to events for an address (pubkey) via polling.
   * Polls the relay for events that reference the given pubkey.
   */
  async subscribeTransactions(
    address: Address,
    callback: (tx: TransactionInfo) => void,
  ): Promise<Unsubscribe> {
    const pubkey = normalizeAddress(address)
    let lastTimestamp = Math.floor(Date.now() / 1000)
    let active = true

    const poll = async () => {
      while (active) {
        try {
          const events = await this.rpc.request<NostrEvent[]>(
            'nostr_getEvents',
            [{ authors: [pubkey], since: lastTimestamp, limit: 50 }],
          )

          if (events && Array.isArray(events)) {
            for (const event of events) {
              if (event.created_at > lastTimestamp) {
                const pTags = event.tags.filter((t) => t[0] === 'p')
                const recipient = pTags.length > 0 ? pTags[0][1] : null
                const amountTag = event.tags.find((t) => t[0] === 'amount')
                const amount = amountTag ? amountTag[1] : '0'

                callback({
                  hash: event.id,
                  from: event.pubkey,
                  to: recipient,
                  value: amount,
                  fee: '0',
                  blockNumber: null,
                  blockHash: null,
                  status: 'confirmed',
                  timestamp: event.created_at,
                  data: event.content || undefined,
                })
              }
            }

            const maxTimestamp = events.reduce(
              (max, e) => Math.max(max, e.created_at),
              lastTimestamp,
            )
            if (maxTimestamp > lastTimestamp) {
              lastTimestamp = maxTimestamp
            }
          }
        } catch {
          // Silently ignore polling errors
        }

        if (active) {
          await new Promise((resolve) => setTimeout(resolve, this.pollInterval))
        }
      }
    }

    poll()

    return () => {
      active = false
    }
  }
}
