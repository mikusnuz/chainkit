export { BitcoinSigner } from './signer.js'
export { BitcoinProvider } from './provider.js'
export type { BitcoinProviderConfig } from './provider.js'
export type { BtcTransactionData, BtcFeeDetail } from './types.js'

import { BitcoinSigner } from './signer.js'
import { BitcoinProvider } from './provider.js'

export const bitcoin = {
  name: 'bitcoin' as const,
  Signer: BitcoinSigner,
  Provider: BitcoinProvider,
}
