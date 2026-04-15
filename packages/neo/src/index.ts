export { NeoSigner } from './signer.js'
export { NeoProvider } from './provider.js'

import { NeoSigner } from './signer.js'
import { NeoProvider } from './provider.js'

export const neo = {
  name: 'neo' as const,
  Signer: NeoSigner,
  Provider: NeoProvider,
}
