import type { ChainsConfig, ReadOnlyChainInstance, FullChainInstance } from './types.js'
import { createChainInstance } from './chain-instance.js'

/**
 * Client configuration.
 */
export interface ClientConfig {
  chains: ChainsConfig
}

/**
 * Create a unified multi-chain client.
 *
 * Each chain entry is instantiated as either a ReadOnlyChainInstance
 * (when no key material is provided) or a FullChainInstance (when
 * privateKey or mnemonic+hdPath is given).
 *
 * @example
 * ```ts
 * import { createClient } from '@chainkit/client'
 * import { ethereum } from '@chainkit/ethereum'
 *
 * const client = await createClient({
 *   chains: {
 *     ethereum: {
 *       chain: ethereum,
 *       rpcs: ['https://eth.llamarpc.com'],
 *       privateKey: '0x...',
 *     },
 *   },
 * })
 *
 * const balance = await client.ethereum.getBalance('0x...')
 * const txHash = await client.ethereum.send({ to: '0x...', amount: '1000' })
 * ```
 */
export async function createClient<T extends ChainsConfig>(
  config: ClientConfig & { chains: T },
): Promise<{
  [K in keyof T]: T[K]['privateKey'] extends string
    ? FullChainInstance
    : T[K]['mnemonic'] extends string
      ? FullChainInstance
      : ReadOnlyChainInstance
}> {
  const entries = Object.entries(config.chains)
  const instances = await Promise.all(
    entries.map(async ([name, chainConfig]) => {
      const instance = await createChainInstance(chainConfig)
      return [name, instance] as const
    }),
  )

  return Object.fromEntries(instances) as {
    [K in keyof T]: T[K]['privateKey'] extends string
      ? FullChainInstance
      : T[K]['mnemonic'] extends string
        ? FullChainInstance
        : ReadOnlyChainInstance
  }
}
