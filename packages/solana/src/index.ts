export { SolanaSigner } from './signer.js'
export { SolanaProvider } from './provider.js'
export type { SolTransactionData, SolFeeDetail } from './types.js'

import { SolanaSigner } from './signer.js'
import { SolanaProvider } from './provider.js'

export const solana = {
  name: 'solana' as const,
  Signer: SolanaSigner,
  Provider: SolanaProvider,
}
