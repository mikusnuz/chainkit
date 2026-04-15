export { VeChainSigner, VECHAIN_HD_PATH } from './signer.js'
export { VeChainProvider } from './provider.js'
export type { VeChainClause, VeChainTransactionBody, VeChainProviderConfig } from './types.js'

import { VeChainSigner } from './signer.js'
import { VeChainProvider } from './provider.js'

export const vechain = {
  name: 'vechain' as const,
  Signer: VeChainSigner,
  Provider: VeChainProvider,
}
