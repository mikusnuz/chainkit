import { useState } from 'react'
import type { ActionResult } from '../hooks/useChain'
import type { ChainConfig } from '../config'
import ResultViewer from './ResultViewer'

interface ActionsSectionProps {
  config: ChainConfig
  connected: boolean
  walletAddress: string | null
  balanceResult: ActionResult
  chainInfoResult: ActionResult
  txResult: ActionResult
  sendResult: ActionResult
  onGetBalance: (address: string) => void
  onGetChainInfo: () => void
  onGetTransaction: (hash: string) => void
  onSendTransaction: (signedTx: string) => void
}

const ActionsSection = ({
  config,
  connected,
  walletAddress,
  balanceResult,
  chainInfoResult,
  txResult,
  sendResult,
  onGetBalance,
  onGetChainInfo,
  onGetTransaction,
  onSendTransaction,
}: ActionsSectionProps) => {
  const [balanceAddr, setBalanceAddr] = useState('')
  const [txHash, setTxHash] = useState('')
  const [signedTx, setSignedTx] = useState('')

  const effectiveBalanceAddr = balanceAddr || walletAddress || ''

  return (
    <div className="space-y-6">
      <div className="section-title">Actions</div>

      {/* Get Balance */}
      <div>
        <div className="text-xs text-gray-400 font-medium mb-2">Get Balance</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={balanceAddr}
            onChange={e => setBalanceAddr(e.target.value)}
            placeholder={walletAddress ? `Default: ${walletAddress.slice(0, 20)}...` : 'Address'}
            className="input-field mono text-xs flex-1"
            disabled={!connected}
          />
          <button
            onClick={() => onGetBalance(effectiveBalanceAddr)}
            disabled={!connected || balanceResult.loading || !effectiveBalanceAddr}
            className="btn-primary shrink-0"
          >
            {balanceResult.loading ? '...' : 'Fetch'}
          </button>
        </div>
        <ResultViewer
          data={balanceResult.data}
          error={balanceResult.error}
          loading={balanceResult.loading}
          label="Balance Result"
        />
      </div>

      {/* Get Chain Info */}
      <div>
        <div className="text-xs text-gray-400 font-medium mb-2">Get Chain Info</div>
        <button
          onClick={onGetChainInfo}
          disabled={!connected || chainInfoResult.loading}
          className="btn-secondary w-full"
        >
          {chainInfoResult.loading ? 'Loading...' : `Get ${config.name} Chain Info`}
        </button>
        <ResultViewer
          data={chainInfoResult.data}
          error={chainInfoResult.error}
          loading={chainInfoResult.loading}
          label="Chain Info"
        />
      </div>

      {/* Get Transaction */}
      <div>
        <div className="text-xs text-gray-400 font-medium mb-2">Get Transaction</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={txHash}
            onChange={e => setTxHash(e.target.value)}
            placeholder="Transaction hash..."
            className="input-field mono text-xs flex-1"
            disabled={!connected}
          />
          <button
            onClick={() => onGetTransaction(txHash)}
            disabled={!connected || txResult.loading || !txHash.trim()}
            className="btn-primary shrink-0"
          >
            {txResult.loading ? '...' : 'Lookup'}
          </button>
        </div>
        <ResultViewer
          data={txResult.data}
          error={txResult.error}
          loading={txResult.loading}
          label="Transaction Details"
        />
      </div>

      {/* Broadcast Transaction */}
      <div>
        <div className="text-xs text-gray-400 font-medium mb-2">Broadcast Transaction</div>
        <div className="text-xs text-gray-500 mb-2">Paste a pre-signed raw transaction hex to broadcast.</div>
        <textarea
          value={signedTx}
          onChange={e => setSignedTx(e.target.value)}
          placeholder="0x... (signed raw transaction)"
          rows={3}
          className="input-field mono text-xs resize-none mb-2"
          disabled={!connected}
        />
        <button
          onClick={() => onSendTransaction(signedTx)}
          disabled={!connected || sendResult.loading || !signedTx.trim()}
          className="btn-primary w-full"
        >
          {sendResult.loading ? 'Broadcasting...' : 'Broadcast'}
        </button>
        <ResultViewer
          data={sendResult.data}
          error={sendResult.error}
          loading={sendResult.loading}
          label="Broadcast Result"
        />
      </div>

      {!connected && (
        <div className="text-xs text-gray-600 text-center">
          Connect to a provider to enable actions.
        </div>
      )}
    </div>
  )
}

export default ActionsSection
