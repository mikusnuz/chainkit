export { TronSigner, addressToHex, hexToAddress } from './signer.js'
export { TronProvider } from './provider.js'
export type { TronProviderConfig } from './provider.js'
export type { TronTransactionData, TronFeeDetail } from './types.js'

import { TronSigner } from './signer.js'
import { TronProvider } from './provider.js'

export const tron = {
  name: 'tron' as const,
  Signer: TronSigner,
  Provider: TronProvider,
}
