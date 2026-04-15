export { SuiSigner } from './signer.js'
export { SuiProvider } from './provider.js'
export type { SuiTransactionData, SuiFeeDetail } from './types.js'

import { SuiSigner } from './signer.js'
import { SuiProvider } from './provider.js'

export const sui = {
  name: 'sui' as const,
  Signer: SuiSigner,
  Provider: SuiProvider,
}
