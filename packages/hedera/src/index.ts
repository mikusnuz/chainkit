export { HederaSigner, HEDERA_DEFAULT_PATH } from './signer.js'
export { HederaProvider } from './provider.js'
export type { HederaMirrorNodeConfig } from './provider.js'
export type { HederaTransactionData, HederaFeeDetail } from './types.js'

import { HederaSigner } from './signer.js'
import { HederaProvider } from './provider.js'

export const hedera = {
  name: 'hedera' as const,
  Signer: HederaSigner,
  Provider: HederaProvider,
}
