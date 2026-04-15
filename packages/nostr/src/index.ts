export { NostrSigner, NOSTR_HD_PATH, privkeyToNsec, decodeBech32 } from './signer.js'
export { NostrProvider } from './provider.js'
export type { NostrProviderConfig } from './provider.js'
export type { NostrEventData, NostrFeeDetail, NostrEvent } from './types.js'

import { NostrSigner } from './signer.js'
import { NostrProvider } from './provider.js'

export const nostr = {
  name: 'nostr' as const,
  Signer: NostrSigner,
  Provider: NostrProvider,
}
