export { HederaSigner, HederaEcdsaSigner, HEDERA_DEFAULT_PATH, HEDERA_ECDSA_PATH } from './signer.js'
export { HederaProvider, HederaRelayProvider } from './provider.js'
export type { HederaMirrorNodeConfig, HederaRelayConfig } from './provider.js'
export type { HederaTransactionData, HederaFeeDetail } from './types.js'

import { HederaSigner, HederaEcdsaSigner } from './signer.js'
import { HederaProvider, HederaRelayProvider } from './provider.js'

export const hedera = {
  name: 'hedera' as const,
  Signer: HederaSigner,
  EcdsaSigner: HederaEcdsaSigner,
  Provider: HederaProvider,
  RelayProvider: HederaRelayProvider,
}
