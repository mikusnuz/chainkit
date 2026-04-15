export { AptosSigner } from './signer.js'
export { AptosProvider } from './provider.js'
export type { AptosProviderConfig } from './provider.js'
export type { AptosTransactionData, AptosFeeDetail } from './types.js'

import { AptosSigner } from './signer.js'
import { AptosProvider } from './provider.js'

export const aptos = {
  name: 'aptos' as const,
  Signer: AptosSigner,
  Provider: AptosProvider,
}
