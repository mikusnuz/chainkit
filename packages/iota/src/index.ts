export {
  IotaSigner,
  serializeTransactionEssence,
  buildTransactionPayload,
} from './signer.js'
export { IotaProvider } from './provider.js'
export type { IotaProviderConfig } from './provider.js'
export type {
  IotaTransactionEssence,
  IotaOutputResponse,
  IotaOutputsResponse,
  IotaBlockResponse,
  IotaNodeInfoResponse,
} from './types.js'

import { IotaSigner } from './signer.js'
import { IotaProvider } from './provider.js'

export const iota = {
  name: 'iota' as const,
  Signer: IotaSigner,
  Provider: IotaProvider,
}
