export { FlowSigner } from './signer.js'
export { FlowProvider } from './provider.js'
export type { FlowProviderConfig } from './provider.js'
export type { FlowTransactionData, FlowFeeDetail } from './types.js'

import { FlowSigner } from './signer.js'
import { FlowProvider } from './provider.js'

export const flow = {
  name: 'flow' as const,
  Signer: FlowSigner,
  Provider: FlowProvider,
}
