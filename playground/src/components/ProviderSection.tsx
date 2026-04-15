import { useState } from 'react'
import type { ProviderState } from '../hooks/useChain'

interface ProviderSectionProps {
  providerState: ProviderState
  onConnect: (rpcUrl: string, strategy: 'failover' | 'round-robin' | 'fastest') => void
  hasRpc: boolean
}

const ProviderSection = ({ providerState, onConnect, hasRpc }: ProviderSectionProps) => {
  const [rpcUrl, setRpcUrl] = useState(providerState.rpcUrl)
  const [strategy, setStrategy] = useState<'failover' | 'round-robin' | 'fastest'>(providerState.strategy)

  return (
    <div className="space-y-4">
      <div className="section-title">Provider / RPC</div>

      {!hasRpc && (
        <div className="text-xs text-yellow-400/80 bg-yellow-950/20 border border-yellow-900/40 rounded p-2 mono">
          No testnet RPC configured for this chain. Provider actions are disabled.
        </div>
      )}

      <div>
        <label className="block text-xs text-gray-400 mb-1">RPC URL</label>
        <input
          type="text"
          value={rpcUrl}
          onChange={e => setRpcUrl(e.target.value)}
          className="input-field mono text-xs"
          placeholder="https://..."
          disabled={!hasRpc}
        />
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">RPC Strategy</label>
        <select
          value={strategy}
          onChange={e => setStrategy(e.target.value as 'failover' | 'round-robin' | 'fastest')}
          className="input-field text-xs"
          disabled={!hasRpc}
        >
          <option value="failover">Failover</option>
          <option value="round-robin">Round Robin</option>
          <option value="fastest">Fastest</option>
        </select>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => onConnect(rpcUrl, strategy)}
          disabled={!hasRpc || providerState.connecting || !rpcUrl}
          className="btn-primary flex-1"
        >
          {providerState.connecting ? 'Connecting...' : providerState.connected ? 'Reconnect' : 'Connect'}
        </button>

        <div className="flex items-center gap-2 text-xs">
          <span
            className={`status-dot ${
              providerState.connected
                ? 'bg-green-400 shadow-sm shadow-green-400/50'
                : 'bg-gray-600'
            }`}
          />
          <span className={providerState.connected ? 'text-green-400' : 'text-gray-500'}>
            {providerState.connecting ? 'Connecting' : providerState.connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      {providerState.error && (
        <div className="text-red-400 text-xs mono bg-red-950/20 border border-red-900/40 rounded p-2">
          {providerState.error}
        </div>
      )}

      {providerState.connected && (
        <div className="text-xs text-gray-500">
          <span className="text-yellow-500/80">Note:</span> Browser fetch may be blocked by CORS for some RPC endpoints.
        </div>
      )}
    </div>
  )
}

export default ProviderSection
