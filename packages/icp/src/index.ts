export { IcpSigner } from './signer.js'
export { IcpProvider } from './provider.js'
export type { IcpProviderConfig } from './provider.js'
export type { IcpTransactionData, IcpFeeDetail } from './types.js'
export {
  derEncodePublicKey,
  derivePrincipal,
  deriveAccountId,
  principalToText,
} from './signer.js'

import { IcpSigner } from './signer.js'
import { IcpProvider } from './provider.js'

export const icp = {
  name: 'icp' as const,
  Signer: IcpSigner,
  Provider: IcpProvider,
}
