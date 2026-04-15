import { useState } from 'react'
import type { WalletState } from '../hooks/useChain'
import type { ChainConfig } from '../config'

interface WalletSectionProps {
  config: ChainConfig
  wallet: WalletState
  onDerive: (mnemonic: string, path: string) => void
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      onClick={handleCopy}
      className="btn-ghost text-xs ml-1 shrink-0"
      title="Copy to clipboard"
    >
      {copied ? (
        <span className="text-green-400">Copied</span>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  )
}

const WalletSection = ({ config, wallet, onDerive }: WalletSectionProps) => {
  const [mnemonic, setMnemonic] = useState(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  )
  const [path, setPath] = useState(config.hdPath)
  const [showKey, setShowKey] = useState(false)

  return (
    <div className="space-y-4">
      <div className="section-title">Wallet Derivation</div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">Mnemonic Phrase</label>
        <textarea
          value={mnemonic}
          onChange={e => setMnemonic(e.target.value)}
          rows={2}
          className="input-field mono text-xs resize-none"
          spellCheck={false}
          placeholder="Enter BIP39 mnemonic..."
        />
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">HD Path</label>
        <input
          type="text"
          value={path}
          onChange={e => setPath(e.target.value)}
          className="input-field mono text-xs"
          placeholder="m/44'/60'/0'/0/0"
        />
      </div>

      <button
        onClick={() => onDerive(mnemonic, path)}
        disabled={wallet.loading || !mnemonic.trim()}
        className="btn-primary w-full"
      >
        {wallet.loading ? 'Deriving...' : 'Derive Wallet'}
      </button>

      {wallet.error && (
        <div className="text-red-400 text-xs mono bg-red-950/20 border border-red-900/40 rounded p-2">
          {wallet.error}
        </div>
      )}

      {wallet.address && (
        <div className="space-y-2">
          <div className="card p-3 space-y-2">
            <div>
              <div className="text-xs text-gray-500 mb-1">Address</div>
              <div className="flex items-start gap-1">
                <span className="mono text-xs text-green-400 break-all leading-relaxed">{wallet.address}</span>
                <div className="flex items-center shrink-0 mt-0.5">
                  <CopyButton text={wallet.address} />
                  {config.explorer && (
                    <a
                      href={`${config.explorer}/address/${wallet.address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-ghost text-xs"
                      title="View in explorer"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </a>
                  )}
                </div>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500">Private Key</span>
                <button
                  onClick={() => setShowKey(prev => !prev)}
                  className="btn-ghost text-xs"
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <div className="flex items-start gap-1">
                <span className="mono text-xs text-yellow-300/80 break-all leading-relaxed">
                  {showKey ? wallet.privateKey : '•'.repeat(Math.min((wallet.privateKey?.length ?? 0), 64))}
                </span>
                {showKey && wallet.privateKey && (
                  <CopyButton text={wallet.privateKey} />
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default WalletSection
