export { CardanoSigner } from './signer.js'
export { CardanoProvider } from './provider.js'
export type { CardanoNetwork } from './signer.js'
export type { CardanoProviderConfig } from './provider.js'
export type { CardanoTransactionData, CardanoFeeDetail, CardanoTxInput, CardanoTxOutput } from './types.js'

import { CardanoSigner } from './signer.js'
import { CardanoProvider } from './provider.js'

export const cardano = {
  name: 'cardano' as const,
  Signer: CardanoSigner,
  Provider: CardanoProvider,
}
