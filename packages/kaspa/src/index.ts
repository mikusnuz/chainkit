export { KaspaSigner } from './signer.js'
export { KaspaProvider } from './provider.js'
export type { KaspaTransactionData, KaspaFeeDetail } from './types.js'

import { KaspaSigner } from './signer.js'
import { KaspaProvider } from './provider.js'

export const kaspa = {
  name: 'kaspa' as const,
  Signer: KaspaSigner,
  Provider: KaspaProvider,
}
