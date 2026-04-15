export {
  PolkadotSigner,
  encodeSS58,
  decodeSS58,
  POLKADOT_DEFAULT_PATH,
  scaleCompactEncode,
  scaleEncodeU32LE,
  scaleEncodeU128LE,
  encodeEra,
  buildTransferKeepAliveCallData,
  buildSigningPayload,
  assembleSignedExtrinsic,
  concatBytes,
} from './signer.js'
export type { PolkadotNetwork } from './signer.js'
export { PolkadotProvider } from './provider.js'
export type { PolkadotTransactionData, PolkadotFeeDetail, PolkadotTxExtra } from './types.js'

import { PolkadotSigner } from './signer.js'
import { PolkadotProvider } from './provider.js'

export const polkadot = {
  name: 'polkadot' as const,
  Signer: PolkadotSigner,
  Provider: PolkadotProvider,
}
