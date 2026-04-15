export { StacksSigner } from './signer.js'
export { StacksProvider } from './provider.js'
export type { StacksTransactionData, StacksFeeDetail } from './types.js'
export type { StacksProviderConfig } from './provider.js'
export {
  c32checkEncode,
  c32checkDecode,
  c32encode,
  c32decode,
  isValidStacksAddress,
  hash160ToAddress,
  DEFAULT_PATH,
  VERSION_MAINNET_SINGLE_SIG,
  VERSION_TESTNET_SINGLE_SIG,
} from './signer.js'

import { StacksSigner } from './signer.js'
import { StacksProvider } from './provider.js'

export const stacks = {
  name: 'stacks' as const,
  Signer: StacksSigner,
  Provider: StacksProvider,
}
