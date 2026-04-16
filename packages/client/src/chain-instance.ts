import type { ChainProvider, ChainSigner, UnsignedTx, TransactionInfo, WaitForTransactionOptions } from '@chainkit/core'
import { waitForTransaction as waitForTransactionHelper, ChainKitError, ErrorCode } from '@chainkit/core'
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

  // SA-013: Nonce mutex for concurrent sends
  let localNonce: number | null = null
  let nonceMutex = Promise.resolve<number>(0)

  async function getNextNonce(): Promise<number> {
    nonceMutex = nonceMutex.then(async () => {
      if (localNonce === null) {
        const from = signer.getAddress(privateKey)
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

    const from = signer.getAddress(privateKey)

    // SA-013: Use nonce mutex for concurrent send safety
    const [nonce, feeEstimate] = await Promise.all([
      getNextNonce(),
      provider.estimateFee(),
    ])

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
      extra: params.options,
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
      const signed = await signer.signTransaction({ privateKey, tx })
      return provider.broadcastTransaction(signed)
    },

    signTransaction: (txParams) => signer.signTransaction(txParams),
    signMessage: (msgParams) => signer.signMessage(msgParams),

    getAddress(): string {
      return signer.getAddress(privateKey)
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
  const provider = new config.chain.Provider({
    endpoints: config.rpcs,
    strategy: config.strategy,
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
