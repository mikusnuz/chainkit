import { useState } from 'react'
import type { ChainId, ChainGroup } from '../config'
import { CHAIN_CONFIGS } from '../config'
import { useGlobalWallet, ALL_CHAIN_IDS } from '../hooks/useGlobalWallet'

interface GlobalWalletProps {
  onSelectChain: (chainId: ChainId, derivedAddress?: string) => void
}

const GROUP_DOT_COLORS: Record<ChainGroup, string> = {
  Secp256k1: 'bg-amber-400',
  ED25519: 'bg-cyan-400',
  SR25519: 'bg-pink-400',
  Secp256r1: 'bg-emerald-400',
  ECDSA_P256: 'bg-rose-400',
  STARK: 'bg-purple-400',
  Pasta: 'bg-orange-400',
}

function truncateMiddle(str: string, maxLen = 42): string {
  if (str.length <= maxLen) return str
  const half = Math.floor((maxLen - 3) / 2)
  return str.slice(0, half) + '...' + str.slice(str.length - half)
}

function CopyInlineButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      onClick={handleCopy}
      className="text-gray-500 hover:text-gray-300 transition-colors text-[11px]"
    >
      {copied ? <span className="text-green-400">Copied</span> : 'Copy'}
    </button>
  )
}

function CopyAllButton({ onCopy }: { onCopy: () => Promise<void> }) {
  const [copied, setCopied] = useState(false)
  const handleClick = async () => {
    await onCopy()
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      onClick={handleClick}
      className="px-3 py-1 text-xs bg-surface-300 hover:bg-surface-400 rounded text-gray-300 transition-colors"
    >
      {copied ? <span className="text-green-400">Copied All</span> : 'Copy All'}
    </button>
  )
}

const GlobalWallet = ({ onSelectChain }: GlobalWalletProps) => {
  const { mnemonic, setMnemonic, addresses, deriving, deriveAll, copyAll } = useGlobalWallet()
  const [collapsed, setCollapsed] = useState(false)
  const hasResults = Object.keys(addresses).length > 0

  return (
    <div className="border-b border-surface-300 bg-surface-100">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-200">Global Wallet</h2>
            {hasResults && (
              <span className="text-[10px] bg-surface-300 text-gray-500 px-1.5 py-0.5 rounded">
                {ALL_CHAIN_IDS.filter(id => addresses[id]?.address).length} / {ALL_CHAIN_IDS.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {hasResults && <CopyAllButton onCopy={copyAll} />}
            <button
              onClick={deriveAll}
              disabled={deriving || !mnemonic.trim()}
              className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-white transition-colors"
            >
              {deriving ? 'Deriving...' : 'Derive All Chains'}
            </button>
            {hasResults && (
              <button
                onClick={() => setCollapsed(prev => !prev)}
                className="text-gray-500 hover:text-gray-300 transition-colors"
                title={collapsed ? 'Expand' : 'Collapse'}
              >
                <svg
                  className={`w-4 h-4 transition-transform ${collapsed ? '' : 'rotate-180'}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <textarea
          value={mnemonic}
          onChange={e => setMnemonic(e.target.value)}
          placeholder="Enter BIP39 mnemonic phrase..."
          spellCheck={false}
          className="w-full bg-surface-200 border border-surface-400 rounded p-2 text-xs mono text-gray-200 h-14 resize-none focus:outline-none focus:border-indigo-600/60 transition-colors"
        />

        {deriving && (
          <div className="flex items-center gap-1.5 mt-2">
            <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse" />
            <span className="text-xs text-gray-500">Deriving addresses for all 30 chains...</span>
          </div>
        )}
      </div>

      {hasResults && !collapsed && (
        <div className="max-h-80 overflow-y-auto border-t border-surface-300">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-100 z-10">
              <tr className="text-gray-500 border-b border-surface-300">
                <th className="text-left py-1.5 px-4 w-32 font-medium">Chain</th>
                <th className="text-left py-1.5 px-2 font-medium">Address</th>
                <th className="text-left py-1.5 px-4 w-28 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ALL_CHAIN_IDS.map(chainId => {
                const config = CHAIN_CONFIGS[chainId]
                const result = addresses[chainId]
                const hasError = Boolean(result?.error)
                const hasAddress = Boolean(result?.address)

                return (
                  <tr
                    key={chainId}
                    className="border-b border-surface-300/40 hover:bg-surface-200 transition-colors cursor-pointer"
                    onClick={() => onSelectChain(chainId, result?.address || undefined)}
                  >
                    <td className="py-1.5 px-4">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${GROUP_DOT_COLORS[config.group]}`}
                        />
                        <span className="text-gray-300">{config.name}</span>
                      </div>
                    </td>
                    <td className="py-1.5 px-2">
                      {hasError ? (
                        <span className="text-red-400 text-[11px]" title={result.error}>
                          Error: {result.error?.slice(0, 40)}
                        </span>
                      ) : hasAddress ? (
                        <div className="flex items-center gap-1.5">
                          <span className="mono text-gray-400 text-[11px]" title={result.address}>
                            {truncateMiddle(result.address)}
                          </span>
                          <svg
                            className="w-3 h-3 text-green-400 shrink-0"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="py-1.5 px-4" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        {hasAddress && <CopyInlineButton text={result.address} />}
                        {hasAddress && config.explorer && (
                          <a
                            href={`${config.explorer}/address/${result.address}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-indigo-400 hover:text-indigo-300 transition-colors text-[11px]"
                          >
                            View
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default GlobalWallet
