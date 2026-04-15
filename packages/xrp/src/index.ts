export { XrpSigner } from './signer.js'
export { XrpProvider } from './provider.js'
export type { XrpTransactionData, XrpFeeDetail } from './types.js'

import { XrpSigner } from './signer.js'
import { XrpProvider } from './provider.js'

export const xrp = {
  name: 'xrp' as const,
  Signer: XrpSigner,
  Provider: XrpProvider,
}
