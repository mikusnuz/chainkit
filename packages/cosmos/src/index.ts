export { CosmosSigner } from './signer.js'
export { CosmosProvider } from './provider.js'
export type { CosmosProviderConfig } from './provider.js'
export type { CosmosTransactionData, CosmosFeeDetail } from './types.js'

import { CosmosSigner } from './signer.js'
import { CosmosProvider } from './provider.js'

export const cosmos = {
  name: 'cosmos' as const,
  Signer: CosmosSigner,
  Provider: CosmosProvider,
}
