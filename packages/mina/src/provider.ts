import {
  ChainKitError,
  ErrorCode,
  waitForTransaction as waitForTransactionHelper,
} from '@chainkit/core'
import type {
  ChainProvider,
  FeeEstimate,
  Address,
  TxHash,
  Balance,
  TransactionInfo,
  WaitForTransactionOptions,
  BlockInfo,
  ChainInfo,
  HexString,
  ProviderConfig,
  EndpointInput,
} from '@chainkit/core'
import type { MinaSignature } from './types.js'

/**
 * Resolve endpoint URL from ProviderConfig.
 * Mina uses GraphQL, so we just need the base URL.
 */
function resolveEndpoint(config: ProviderConfig): string {
  const endpoints = config.endpoints
  if (typeof endpoints === 'string') return endpoints
  if (Array.isArray(endpoints)) {
    const first = endpoints[0]
    if (typeof first === 'string') return first
    if (first && typeof first === 'object' && 'url' in first) return first.url
    throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'No valid endpoint provided')
  }
  if (typeof endpoints === 'object' && !Array.isArray(endpoints)) {
    // Check if it has a 'url' property (EndpointConfig)
    if ('url' in endpoints) return (endpoints as { url: string }).url
    // Otherwise it's the categorized format
    const categorized = endpoints as { rpc?: EndpointInput; rest?: EndpointInput; lcd?: EndpointInput; indexer?: EndpointInput; mirror?: EndpointInput }
    const rpc = categorized.rpc
    if (rpc) {
      if (typeof rpc === 'string') return rpc
      if (Array.isArray(rpc)) {
        const first = rpc[0]
        if (typeof first === 'string') return first
        if (first && typeof first === 'object' && 'url' in first) return first.url
      }
      if (typeof rpc === 'object' && !Array.isArray(rpc) && 'url' in rpc) return (rpc as { url: string }).url
    }
  }
  throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'No valid endpoint provided')
}

/**
 * Mina provider implementing ChainProvider.
 *
 * Mina uses a GraphQL API instead of JSON-RPC. This provider
 * makes GraphQL POST requests to the configured endpoint.
 *
 * Default testnet: https://devnet.minaprotocol.network/graphql
 */
export class MinaProvider implements ChainProvider {
  private readonly endpoint: string
  private readonly timeoutMs: number

  constructor(config: ProviderConfig) {
    this.endpoint = resolveEndpoint(config)
    this.timeoutMs = config.timeoutMs ?? 10000
  }

  /**
   * Execute a GraphQL query/mutation against the Mina node.
   */
  private async graphql<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      })

      if (!res.ok) {
        throw new ChainKitError(
          ErrorCode.RPC_ERROR,
          `GraphQL request failed with status ${res.status}: ${res.statusText}`,
        )
      }

      const json = await res.json() as { data?: T; errors?: Array<{ message: string }> }

      if (json.errors && json.errors.length > 0) {
        throw new ChainKitError(
          ErrorCode.RPC_ERROR,
          `GraphQL error: ${json.errors[0].message}`,
        )
      }

      return json.data as T
    } catch (err) {
      if (err instanceof ChainKitError) throw err
      if ((err as Error).name === 'AbortError') {
        throw new ChainKitError(ErrorCode.TIMEOUT, 'GraphQL request timed out')
      }
      throw new ChainKitError(
        ErrorCode.RPC_ERROR,
        `GraphQL request failed: ${(err as Error).message}`,
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  // ------- ChainProvider -------

  /**
   * Get the MINA balance of an address.
   * Balance is returned in nanomina (1 MINA = 1,000,000,000 nanomina).
   */
  async getBalance(address: Address): Promise<Balance> {
    const data = await this.graphql<{
      account: { balance: { total: string } } | null
    }>(`
      query ($publicKey: PublicKey!) {
        account(publicKey: $publicKey) {
          balance {
            total
          }
        }
      }
    `, { publicKey: address })

    const total = data?.account?.balance?.total ?? '0'

    return {
      address,
      amount: total,
      symbol: 'MINA',
      decimals: 9,
    }
  }

  /**
   * Get the nonce (inferred nonce) for an account.
   */
  async getNonce(address: Address): Promise<number> {
    const data = await this.graphql<{
      account: { nonce: string } | null
    }>(`
      query ($publicKey: PublicKey!) {
        account(publicKey: $publicKey) {
          nonce
        }
      }
    `, { publicKey: address })

    return parseInt(data?.account?.nonce ?? '0', 10)
  }

  /**
   * Get transaction details by hash.
   */
  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    const data = await this.graphql<{
      transaction: {
        hash: string
        from: string
        to: string
        amount: string
        fee: string
        nonce: number
        memo: string
        blockHeight: number | null
        failureReason: string | null
        dateTime: string | null
      } | null
    }>(`
      query ($hash: String!) {
        transaction(hash: $hash) {
          hash
          from
          to
          amount
          fee
          nonce
          memo
          blockHeight
          failureReason
          dateTime
        }
      }
    `, { hash })

    if (!data?.transaction) return null

    const tx = data.transaction
    let status: 'pending' | 'confirmed' | 'failed' = 'pending'
    if (tx.failureReason) {
      status = 'failed'
    } else if (tx.blockHeight) {
      status = 'confirmed'
    }

    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: tx.amount,
      fee: tx.fee,
      blockNumber: tx.blockHeight,
      blockHash: null,
      status,
      timestamp: tx.dateTime ? Math.floor(new Date(tx.dateTime).getTime() / 1000) : null,
      nonce: tx.nonce,
    }
  }

  /**
   * Get block details by block height.
   */
  async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
    const height = typeof hashOrNumber === 'number' ? hashOrNumber : parseInt(hashOrNumber, 10)

    const data = await this.graphql<{
      block: {
        stateHash: string
        protocolState: {
          previousStateHash: string
          consensusState: {
            blockHeight: string
          }
        }
        dateTime: string
        transactions: {
          userCommands: Array<{ hash: string }>
        }
      } | null
    }>(`
      query ($height: Int!) {
        block(height: $height) {
          stateHash
          protocolState {
            previousStateHash
            consensusState {
              blockHeight
            }
          }
          dateTime
          transactions {
            userCommands {
              hash
            }
          }
        }
      }
    `, { height })

    if (!data?.block) return null

    const block = data.block
    const blockNumber = parseInt(block.protocolState.consensusState.blockHeight, 10)

    return {
      number: blockNumber,
      hash: block.stateHash,
      parentHash: block.protocolState.previousStateHash,
      timestamp: Math.floor(new Date(block.dateTime).getTime() / 1000),
      transactions: block.transactions.userCommands.map(
        (cmd: { hash: string }) => cmd.hash,
      ),
    }
  }

  /**
   * Estimate transaction fees.
   * Mina has a minimum fee, typical fees are returned as slow/average/fast.
   */
  async estimateFee(): Promise<FeeEstimate> {
    // Mina has relatively stable fees
    // Minimum fee is 0.001 MINA = 1,000,000 nanomina
    // Typical fees are between 0.01 and 0.1 MINA
    return {
      slow: '10000000',     // 0.01 MINA
      average: '100000000',  // 0.1 MINA
      fast: '500000000',     // 0.5 MINA
      unit: 'nanomina',
    }
  }

  /**
   * Broadcast a signed transaction to the Mina network.
   *
   * Expects the signedTx to be a JSON string from MinaSigner.signTransaction()
   * containing { signature: { field, scalar }, payment: { ... } }.
   */
  async broadcastTransaction(signedTx: HexString): Promise<TxHash> {
    const parsed = JSON.parse(signedTx) as {
      signature: MinaSignature
      payment: {
        from: string
        to: string
        amount: string
        fee: string
        nonce: number
        memo: string
        validUntil: number
      }
    }

    const { signature, payment } = parsed

    const data = await this.graphql<{
      sendPayment: {
        payment: {
          hash: string
        }
      }
    }>(`
      mutation ($input: SendPaymentInput!, $signature: SignatureInput!) {
        sendPayment(input: $input, signature: $signature) {
          payment {
            hash
          }
        }
      }
    `, {
      input: {
        from: payment.from,
        to: payment.to,
        amount: payment.amount,
        fee: payment.fee,
        nonce: String(payment.nonce),
        memo: payment.memo ?? '',
        validUntil: String(payment.validUntil ?? 4294967295),
      },
      signature: {
        field: signature.field,
        scalar: signature.scalar,
      },
    })

    return data.sendPayment.payment.hash
  }

  /**
   * Get chain/network information.
   */
  async getChainInfo(): Promise<ChainInfo> {
    const data = await this.graphql<{
      daemonStatus: {
        chainId: string
        blockchainLength: number
      }
      syncStatus: string
    }>(`
      query {
        daemonStatus {
          chainId
          blockchainLength
        }
        syncStatus
      }
    `)

    const chainId = data?.daemonStatus?.chainId ?? 'mina:mainnet'
    const blockHeight = data?.daemonStatus?.blockchainLength ?? 0
    const isTestnet = chainId.includes('testnet') || chainId.includes('devnet') || chainId.includes('berkeley')

    return {
      chainId,
      name: isTestnet ? 'Mina Devnet' : 'Mina Mainnet',
      symbol: 'MINA',
      decimals: 9,
      testnet: isTestnet,
      blockHeight,
    }
  }

  /**
   * Wait for a transaction to be confirmed.
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
