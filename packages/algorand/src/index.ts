export { AlgorandSigner } from './signer.js'
export { AlgorandProvider } from './provider.js'
export type { AlgorandProviderConfig } from './provider.js'
export type { AlgorandTransactionData, AlgorandFeeDetail } from './types.js'

import { AlgorandSigner } from './signer.js'
import { AlgorandProvider } from './provider.js'

export const algorand = {
  name: 'algorand' as const,
  Signer: AlgorandSigner,
  Provider: AlgorandProvider,
}
