import type { ChainId } from '../config'
import { CHAIN_CONFIGS } from '../config'
import { useChain } from '../hooks/useChain'
import WalletSection from './WalletSection'
import ProviderSection from './ProviderSection'
import ActionsSection from './ActionsSection'

interface ChainPanelProps {
  chainId: ChainId
}

const ChainPanel = ({ chainId }: ChainPanelProps) => {
  const config = CHAIN_CONFIGS[chainId]
  const {
    wallet,
    providerState,
    balanceResult,
    chainInfoResult,
    txResult,
    sendResult,
    deriveWallet,
    connect,
    getBalance,
    getChainInfo,
    getTransaction,
    sendTransaction,
  } = useChain(chainId)

  const hasRpc = Boolean(config.testnetRpc)

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-2xl mx-auto space-y-6 pb-12">
        {/* Header */}
        <div className="flex items-center gap-3 pb-2 border-b border-surface-300">
          <div>
            <h2 className="text-xl font-semibold text-gray-100">{config.name}</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="tag bg-surface-300 text-gray-400">{config.symbol}</span>
              <span className="text-xs text-gray-500">
                {config.decimals > 0 ? `${config.decimals} decimals` : 'no decimals'}
              </span>
              <span className="text-xs text-gray-500">|</span>
              <span className="tag bg-surface-200 text-gray-500 mono text-[10px]">{config.hdPath}</span>
            </div>
          </div>
          {config.explorer && (
            <a
              href={config.explorer}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors"
            >
              Explorer
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )}
        </div>

        {/* Wallet Section */}
        <div className="card p-4">
          <WalletSection
            config={config}
            wallet={wallet}
            onDerive={deriveWallet}
          />
        </div>

        {/* Provider Section */}
        <div className="card p-4">
          <ProviderSection
            providerState={providerState}
            onConnect={connect}
            hasRpc={hasRpc}
          />
        </div>

        {/* Actions Section */}
        <div className="card p-4">
          <ActionsSection
            config={config}
            connected={providerState.connected}
            walletAddress={wallet.address}
            balanceResult={balanceResult}
            chainInfoResult={chainInfoResult}
            txResult={txResult}
            sendResult={sendResult}
            onGetBalance={getBalance}
            onGetChainInfo={getChainInfo}
            onGetTransaction={getTransaction}
            onSendTransaction={sendTransaction}
          />
        </div>
      </div>
    </div>
  )
}

export default ChainPanel
