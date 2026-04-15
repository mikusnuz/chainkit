export { EthereumSigner } from './signer.js'
export { EthereumProvider } from './provider.js'
export type { EvmTransactionData, EvmFeeDetail } from './types.js'

import { EthereumSigner } from './signer.js'
import { EthereumProvider } from './provider.js'

export const ethereum = {
  name: 'ethereum' as const,
  Signer: EthereumSigner,
  Provider: EthereumProvider,
}
