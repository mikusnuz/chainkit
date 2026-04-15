export { KaiaSigner, KAIA_DEFAULT_PATH } from './signer.js'
export { KaiaProvider } from './provider.js'
export type { KaiaTransactionData, KaiaFeeDetail } from './types.js'

import { KaiaSigner } from './signer.js'
import { KaiaProvider } from './provider.js'

export const kaia = {
  name: 'kaia' as const,
  Signer: KaiaSigner,
  Provider: KaiaProvider,
}
