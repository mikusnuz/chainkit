export { TonSigner, rawToUserFriendly } from './signer.js'
export { TonProvider } from './provider.js'
export type { TonProviderConfig } from './provider.js'
export type { TonTransactionData, TonFeeDetail } from './types.js'

import { TonSigner } from './signer.js'
import { TonProvider } from './provider.js'

export const ton = {
  name: 'ton' as const,
  Signer: TonSigner,
  Provider: TonProvider,
}
