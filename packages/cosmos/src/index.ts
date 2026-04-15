export { CosmosSigner, encodeVarint, encodeField, encodeString, encodeBytes, encodeUint64Field, encodeMessage, encodeCoinRaw, encodeMsgSend, encodeAnyRaw, encodeTxBody, encodeAuthInfo, encodeSignDoc, encodeTxRaw, concat } from './signer.js'
export { CosmosProvider } from './provider.js'
export type { CosmosProviderConfig } from './provider.js'
export type { CosmosTransactionData, CosmosFeeDetail } from './types.js'

import { CosmosSigner } from './signer.js'
import { CosmosProvider } from './provider.js'

export const cosmos = {
  name: 'cosmos' as const,
  Signer: CosmosSigner,
  Provider: CosmosProvider,
}
