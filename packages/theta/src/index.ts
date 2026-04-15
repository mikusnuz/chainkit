export { ThetaSigner } from './signer.js'
export { ThetaProvider } from './provider.js'
export type { ThetaTransactionData, ThetaAccountResult, ThetaBlockResult, ThetaBlockTransaction } from './types.js'

import { ThetaSigner } from './signer.js'
import { ThetaProvider } from './provider.js'

export const theta = {
  name: 'theta' as const,
  Signer: ThetaSigner,
  Provider: ThetaProvider,
}
