export { MinaSigner } from './signer.js'
export { MinaProvider } from './provider.js'
export type { MinaTransactionData, MinaSignature } from './types.js'

import { MinaSigner } from './signer.js'
import { MinaProvider } from './provider.js'

export const mina = {
  name: 'mina' as const,
  Signer: MinaSigner,
  Provider: MinaProvider,
}
