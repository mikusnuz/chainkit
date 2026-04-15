export { TezosSigner, publicKeyToTz1Address, encodePublicKey, encodeSignature } from './signer.js'
export { TezosProvider } from './provider.js'
export type { TezosProviderConfig } from './provider.js'
export type { TezosTransactionData, TezosFeeDetail } from './types.js'

import { TezosSigner } from './signer.js'
import { TezosProvider } from './provider.js'

export const tezos = {
  name: 'tezos' as const,
  Signer: TezosSigner,
  Provider: TezosProvider,
}
