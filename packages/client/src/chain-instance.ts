import type { ChainProvider, ChainSigner, UnsignedTx, TransactionInfo, WaitForTransactionOptions } from '@chainkit/core'
import { waitForTransaction as waitForTransactionHelper, ChainKitError, ErrorCode, SecureKey } from '@chainkit/core'
import type {
  ChainConfig,
  ReadOnlyChainInstance,
  FullChainInstance,
  SendParams,
} from './types.js'

/**
 * Create a read-only chain instance that delegates query methods to the provider.
 */
function createReadOnlyInstance(provider: ChainProvider): ReadOnlyChainInstance {
  return {
    getBalance: (address) => provider.getBalance(address),
    getTransaction: (hash) => provider.getTransaction(hash),
    getBlock: (hashOrNumber) => provider.getBlock(hashOrNumber),
    estimateFee: () => provider.estimateFee(),
    getChainInfo: () => provider.getChainInfo(),
    waitForTransaction: (hash: string, options?: WaitForTransactionOptions): Promise<TransactionInfo> => {
      return waitForTransactionHelper(
        (h) => provider.getTransaction(h) as Promise<TransactionInfo>,
        hash,
        options,
      )
    },
    get provider() {
      return provider
    },
  }
}

/**
 * Create a full chain instance with signing and sending capabilities.
 */
function createFullInstance(
  provider: ChainProvider,
  signer: ChainSigner,
  privateKey: string,
): FullChainInstance {
  const readOnly = createReadOnlyInstance(provider)

  // SA-008: Store key material in SecureKey (Uint8Array) instead of string
  // All key usage goes through secureKey — the original string param is not referenced after this
  const secureKey = new SecureKey(privateKey)

  function getKey(): string {
    return secureKey.hex
  }

  // SA-013: Nonce mutex for concurrent sends
  let localNonce: number | null = null
  let nonceMutex = Promise.resolve<number>(0)

  async function getNextNonce(): Promise<number> {
    nonceMutex = nonceMutex.then(async () => {
      if (localNonce === null) {
        const from = signer.getAddress(getKey())
        const n = await provider.getNonce(from)
        localNonce = typeof n === 'number' ? n : parseInt(String(n), 10)
      }
      return localNonce!++
    })
    return nonceMutex
  }

  /**
   * SA-003: Validate recipient address before building a transaction.
   */
  function validateRecipientAddress(to: string): void {
    if (signer.validateAddress && !signer.validateAddress(to)) {
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        `Invalid recipient address: ${to}`,
      )
    }
  }

  /**
   * Build an UnsignedTx by auto-fetching nonce and fee from the provider.
   */
  async function buildUnsignedTx(params: SendParams): Promise<UnsignedTx> {
    // SA-003: Validate recipient address
    validateRecipientAddress(params.to)

    const from = signer.getAddress(getKey())

    // SA-013: Use nonce mutex for concurrent send safety
    // SA-018: Note — when using 'fastest' RPC strategy, nonce and fee
    // responses come from whichever endpoint replies first. A rogue
    // endpoint could return manipulated data. For production wallets,
    // prefer 'failover' strategy to ensure trusted endpoint priority.
    const [nonce, feeEstimate] = await Promise.all([
      getNextNonce(),
      provider.estimateFee(),
    ])

    // SA-014: Strip signing-critical fields from options to prevent
    // output/input override attacks (e.g., Bitcoin fund redirection via extra.outputs)
    let safeExtra: Record<string, unknown> | undefined
    if (params.options) {
      safeExtra = { ...params.options }
      delete safeExtra.outputs
      delete safeExtra.inputs
    }

    // Build tx with auto-fetched params + user overrides
    const tx: UnsignedTx = {
      from,
      to: params.to,
      amount: params.amount,
      value: params.amount,
      data: params.data as string | undefined,
      memo: params.memo,
      nonce: typeof nonce === 'number' ? nonce : parseInt(String(nonce), 10),
      fee: { fee: feeEstimate.average },
      extra: safeExtra,
    }

    return tx
  }

  return {
    ...readOnly,
    get provider() {
      return provider
    },
    get signer() {
      return signer
    },

    async prepareTransaction(params: SendParams): Promise<UnsignedTx> {
      return buildUnsignedTx(params)
    },

    async send(params: SendParams): Promise<string> {
      // Build unsigned tx with auto-fetched nonce and fee
      const tx = await buildUnsignedTx(params)

      // Sign and broadcast
      const signed = await signer.signTransaction({ privateKey: getKey(), tx })
      return provider.broadcastTransaction(signed)
    },

    signTransaction: (txParams) => signer.signTransaction(txParams),
    signMessage: (msgParams) => signer.signMessage(msgParams),

    getAddress(): string {
      return signer.getAddress(getKey())
    },

    destroy(): void {
      secureKey.destroy()
    },
  }
}

/**
 * Create a chain instance from configuration.
 *
 * Returns a ReadOnlyChainInstance when no key material is provided,
 * or a FullChainInstance when a privateKey or mnemonic+hdPath is given.
 */
export async function createChainInstance(
  config: ChainConfig,
): Promise<ReadOnlyChainInstance | FullChainInstance> {
  // XC-005: Auto-downgrade 'fastest' to 'failover' for signing clients.
  // 'fastest' accepts the first RPC response without consensus — a rogue
  // endpoint could return manipulated nonce or fee data for signing.
  const hasSigning = !!(config.privateKey || config.mnemonic)
  const safeStrategy = (config.strategy === 'fastest' && hasSigning)
    ? 'failover'
    : config.strategy

  const provider = new config.chain.Provider({
    endpoints: config.rpcs,
    strategy: safeStrategy,
    timeout: config.timeout,
    retries: config.retries,
  })

  // No key material -> read-only
  if (!config.privateKey && !config.mnemonic) {
    return createReadOnlyInstance(provider)
  }

  const signer = new config.chain.Signer(config.network ?? 'mainnet')
  let privateKey: string

  if (config.privateKey) {
    privateKey = config.privateKey
  } else if (config.mnemonic) {
    const hdPath = config.hdPath || signer.getDefaultHdPath?.()
    if (!hdPath) {
      throw new Error(
        'hdPath is required when using mnemonic-based key derivation (no default available for this chain)',
      )
    }
    privateKey = await signer.derivePrivateKey(config.mnemonic, hdPath)
  } else {
    throw new Error(
      'hdPath is required when using mnemonic-based key derivation',
    )
  }

  return createFullInstance(provider, signer, privateKey)
}
