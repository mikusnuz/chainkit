import type { ChainId, ChainGroup } from '../config'
import { CHAIN_CONFIGS, CHAIN_GROUPS } from '../config'

interface SidebarProps {
  selected: ChainId
  onSelect: (chain: ChainId) => void
}

const GROUP_COLORS: Record<ChainGroup, string> = {
  Secp256k1: 'text-amber-400',
  ED25519: 'text-cyan-400',
  STARK: 'text-purple-400',
}

const GROUP_ORDER: ChainGroup[] = ['Secp256k1', 'ED25519', 'STARK']

const Sidebar = ({ selected, onSelect }: SidebarProps) => {
  return (
    <aside className="w-52 shrink-0 bg-surface-50 border-r border-surface-300 flex flex-col h-full overflow-y-auto">
      <div className="p-4 border-b border-surface-300">
        <div className="text-sm font-semibold text-gray-100">ChainKit</div>
        <div className="text-xs text-gray-500 mt-0.5">Playground</div>
      </div>

      <nav className="flex-1 p-2 space-y-4 py-3">
        {GROUP_ORDER.map(group => (
          <div key={group}>
            <div className={`text-[10px] font-semibold uppercase tracking-widest px-2 mb-1 ${GROUP_COLORS[group]}`}>
              {group}
            </div>
            <ul className="space-y-0.5">
              {CHAIN_GROUPS[group].map(chainId => {
                const config = CHAIN_CONFIGS[chainId]
                const isSelected = selected === chainId
                return (
                  <li key={chainId}>
                    <button
                      onClick={() => onSelect(chainId)}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between group ${
                        isSelected
                          ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-600/30'
                          : 'text-gray-400 hover:text-gray-100 hover:bg-surface-300'
                      }`}
                    >
                      <span>{config.name}</span>
                      <span
                        className={`text-[10px] mono shrink-0 ml-1 ${
                          isSelected ? 'text-indigo-400' : 'text-gray-600 group-hover:text-gray-500'
                        }`}
                      >
                        {config.symbol}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-surface-300">
        <div className="text-[10px] text-gray-600 text-center">
          18 chains supported
        </div>
      </div>
    </aside>
  )
}

export default Sidebar
