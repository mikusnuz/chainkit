export { IconSigner, ICON_HD_PATH } from './signer.js'
export { IconProvider } from './provider.js'
export type { IconTransactionData, ScoreCallParams } from './types.js'

import { IconSigner } from './signer.js'
import { IconProvider } from './provider.js'

export const icon = {
  name: 'icon' as const,
  Signer: IconSigner,
  Provider: IconProvider,
}
