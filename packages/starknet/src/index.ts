export { StarknetSigner, computeContractAddress, OZ_ACCOUNT_CLASS_HASH } from './signer.js'
export { StarknetProvider } from './provider.js'
export type { StarknetTransactionData, StarknetFeeDetail } from './types.js'

import { StarknetSigner } from './signer.js'
import { StarknetProvider } from './provider.js'

export const starknet = {
  name: 'starknet' as const,
  Signer: StarknetSigner,
  Provider: StarknetProvider,
}
