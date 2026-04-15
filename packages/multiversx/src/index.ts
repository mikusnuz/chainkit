export { MultiversXSigner, MULTIVERSX_DEFAULT_PATH, pubkeyToBech32, bech32ToPubkey } from './signer.js'
export { MultiversXProvider } from './provider.js'
export type { MultiversXProviderConfig } from './provider.js'
export type { MultiversXTransactionData, MultiversXFeeDetail, EsdtTransferData } from './types.js'

import { MultiversXSigner } from './signer.js'
import { MultiversXProvider } from './provider.js'

export const multiversx = {
  name: 'multiversx' as const,
  Signer: MultiversXSigner,
  Provider: MultiversXProvider,
}
