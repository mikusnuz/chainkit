export { PolkadotSigner, encodeSS58, decodeSS58, POLKADOT_DEFAULT_PATH } from './signer.js'
export type { PolkadotNetwork } from './signer.js'
export { PolkadotProvider } from './provider.js'
export type { PolkadotTransactionData, PolkadotFeeDetail } from './types.js'

import { PolkadotSigner } from './signer.js'
import { PolkadotProvider } from './provider.js'

export const polkadot = {
  name: 'polkadot' as const,
  Signer: PolkadotSigner,
  Provider: PolkadotProvider,
}
