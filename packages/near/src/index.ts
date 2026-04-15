export { NearSigner } from './signer.js'
export { NearProvider } from './provider.js'
export type { NearTransactionData, NearFeeDetail } from './types.js'

import { NearSigner } from './signer.js'
import { NearProvider } from './provider.js'

export const near = {
  name: 'near' as const,
  Signer: NearSigner,
  Provider: NearProvider,
}
