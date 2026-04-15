export { EosSigner } from './signer.js'
export { EosProvider } from './provider.js'
export type { EosProviderConfig } from './provider.js'
export type { EosTransactionData, EosFeeDetail, EosAction } from './types.js'
export { publicKeyToEosFormat, eosFormatToPublicKey, nameToUint64Bytes, uint64BytesToName, EOS_HD_PATH } from './signer.js'

import { EosSigner } from './signer.js'
import { EosProvider } from './provider.js'

export const eos = {
  name: 'eos' as const,
  Signer: EosSigner,
  Provider: EosProvider,
}
