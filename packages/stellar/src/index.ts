export { StellarSigner, encodeStrKey, decodeStrKey, encodeSecretStrKey } from './signer.js'
export { StellarProvider } from './provider.js'
export type { StellarProviderConfig } from './provider.js'
export type { StellarTransactionData, StellarFeeDetail } from './types.js'

import { StellarSigner } from './signer.js'
import { StellarProvider } from './provider.js'

export const stellar = {
  name: 'stellar' as const,
  Signer: StellarSigner,
  Provider: StellarProvider,
}
