export { ZkspaceSigner, ZKSPACE_DEFAULT_PATH } from './signer.js'
export { ZkspaceProvider } from './provider.js'
export type { ZkspaceProviderConfig } from './provider.js'
export type { ZkspaceTransactionData, ZkspaceFeeDetail } from './types.js'

import { ZkspaceSigner } from './signer.js'
import { ZkspaceProvider } from './provider.js'

export const zkspace = {
  name: 'zkspace' as const,
  Signer: ZkspaceSigner,
  Provider: ZkspaceProvider,
}
