import type { ChainProvider, ChainSigner, UnsignedTx, TransactionInfo, WaitForTransactionOptions } from '@chainkit/core'
import { waitForTransaction as waitForTransactionHelper } from '@chainkit/core'
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

  /**
   * Build an UnsignedTx by auto-fetching nonce and fee from the provider.
   */
  async function buildUnsignedTx(params: SendParams): Promise<UnsignedTx> {
    const from = signer.getAddress(privateKey)

    // Auto-fetch nonce and fee in parallel
    const [nonce, feeEstimate] = await Promise.all([
      provider.getNonce(from),
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

  const signer = new config.chain.Signer()
  let privateKey: string

  if (config.privateKey) {
    privateKey = config.privateKey
  } else if (config.mnemonic && config.hdPath) {
    privateKey = await signer.derivePrivateKey(config.mnemonic, config.hdPath)
  } else {
    // mnemonic without hdPath: use a common default
    throw new Error(
      'hdPath is required when using mnemonic-based key derivation',
    )
  }

  return createFullInstance(provider, signer, privateKey)
}
