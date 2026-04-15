export { FilecoinSigner } from './signer.js'
export { FilecoinProvider } from './provider.js'
export type { FilecoinTransactionData, FilecoinFeeDetail } from './types.js'

import { FilecoinSigner } from './signer.js'
import { FilecoinProvider } from './provider.js'

export const filecoin = {
  name: 'filecoin' as const,
  Signer: FilecoinSigner,
  Provider: FilecoinProvider,
}
