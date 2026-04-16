import { useState } from 'react'
import type { ChainId } from './config'
import Sidebar from './components/Sidebar'
import ChainPanel from './components/ChainPanel'
import GlobalWallet from './components/GlobalWallet'

const App = () => {
  const [selectedChain, setSelectedChain] = useState<ChainId>('ethereum')
  const [globalDerivedAddress, setGlobalDerivedAddress] = useState<string | null>(null)

  const handleSelectChain = (chainId: ChainId, derivedAddress?: string) => {
    setSelectedChain(chainId)
    setGlobalDerivedAddress(derivedAddress ?? null)
  }

  return (
    <div className="flex h-screen overflow-hidden bg-surface-0">
      <Sidebar selected={selectedChain} onSelect={chainId => handleSelectChain(chainId)} />
      <main className="flex-1 overflow-hidden flex flex-col">
        <GlobalWallet onSelectChain={(chainId, derivedAddress) => handleSelectChain(chainId, derivedAddress)} />
        <div className="flex-1 overflow-hidden">
          <ChainPanel
            key={selectedChain}
            chainId={selectedChain}
            prefilledAddress={globalDerivedAddress}
          />
        </div>
      </main>
    </div>
  )
}

export default App
