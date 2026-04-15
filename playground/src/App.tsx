import { useState } from 'react'
import type { ChainId } from './config'
import Sidebar from './components/Sidebar'
import ChainPanel from './components/ChainPanel'

const App = () => {
  const [selectedChain, setSelectedChain] = useState<ChainId>('ethereum')

  return (
    <div className="flex h-screen overflow-hidden bg-surface-0">
      <Sidebar selected={selectedChain} onSelect={setSelectedChain} />
      <main className="flex-1 overflow-hidden">
        <ChainPanel key={selectedChain} chainId={selectedChain} />
      </main>
    </div>
  )
}

export default App
