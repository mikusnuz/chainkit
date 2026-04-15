import type { ChainProvider, ChainSigner } from '@chainkit/core'
import type {
  ChainConfig,
  ReadOnlyChainInstance,
  FullChainInstance,
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

  return {
    ...readOnly,
    get provider() {
      return provider
    },
    get signer() {
      return signer
    },

    async send(params: { to: string; amount: string; data?: unknown }): Promise<string> {
      const address = signer.getAddress(privateKey)
      const fee = await provider.estimateFee()
      const signedTx = await signer.signTransaction(
        {
          from: address,
          to: params.to,
          value: params.amount,
          data: params.data as string | undefined,
          fee: { average: fee.average },
        },
        privateKey,
      )
      return provider.broadcastTransaction(signedTx)
    },

    signTransaction: (tx, pk) => signer.signTransaction(tx, pk),
    signMessage: (message, pk) => signer.signMessage(message, pk),

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
