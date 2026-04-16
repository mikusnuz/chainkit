import { useState, useCallback } from 'react'
import type { ChainId } from '../config'
import { CHAIN_CONFIGS, CHAIN_GROUPS, DEFAULT_MNEMONIC } from '../config'

import { ethereum } from '@chainkit/ethereum'
import { bitcoin } from '@chainkit/bitcoin'
import { solana } from '@chainkit/solana'
import { tron } from '@chainkit/tron'
import { ton } from '@chainkit/ton'
import { cosmos } from '@chainkit/cosmos'
import { aptos } from '@chainkit/aptos'
import { sui } from '@chainkit/sui'
import { near } from '@chainkit/near'
import { xrp } from '@chainkit/xrp'
import { stellar } from '@chainkit/stellar'
import { starknet } from '@chainkit/starknet'
import { stacks } from '@chainkit/stacks'
import { kaia } from '@chainkit/kaia'
import { eos } from '@chainkit/eos'
import { cardano } from '@chainkit/cardano'
import { polkadot } from '@chainkit/polkadot'
import { hedera } from '@chainkit/hedera'
import { filecoin } from '@chainkit/filecoin'
import { icp } from '@chainkit/icp'
import { algorand } from '@chainkit/algorand'
import { vechain } from '@chainkit/vechain'
import { tezos } from '@chainkit/tezos'
import { theta } from '@chainkit/theta'
import { multiversx } from '@chainkit/multiversx'
import { iota } from '@chainkit/iota'
import { neo } from '@chainkit/neo'
import { flow } from '@chainkit/flow'
import { icon } from '@chainkit/icon'
import { mina } from '@chainkit/mina'

type SignerConstructor = new () => {
  derivePrivateKey: (mnemonic: string, path: string) => Promise<string>
  getAddress: (pk: string) => string
}

const CHAIN_MODULES: Record<ChainId, { Signer: SignerConstructor }> = {
  ethereum: ethereum as unknown as { Signer: SignerConstructor },
  bitcoin: bitcoin as unknown as { Signer: SignerConstructor },
  solana: solana as unknown as { Signer: SignerConstructor },
  tron: tron as unknown as { Signer: SignerConstructor },
  ton: ton as unknown as { Signer: SignerConstructor },
  cosmos: cosmos as unknown as { Signer: SignerConstructor },
  aptos: aptos as unknown as { Signer: SignerConstructor },
  sui: sui as unknown as { Signer: SignerConstructor },
  near: near as unknown as { Signer: SignerConstructor },
  xrp: xrp as unknown as { Signer: SignerConstructor },
  stellar: stellar as unknown as { Signer: SignerConstructor },
  starknet: starknet as unknown as { Signer: SignerConstructor },
  stacks: stacks as unknown as { Signer: SignerConstructor },
  kaia: kaia as unknown as { Signer: SignerConstructor },
  eos: eos as unknown as { Signer: SignerConstructor },
  cardano: cardano as unknown as { Signer: SignerConstructor },
  polkadot: polkadot as unknown as { Signer: SignerConstructor },
  hedera: hedera as unknown as { Signer: SignerConstructor },
  filecoin: filecoin as unknown as { Signer: SignerConstructor },
  icp: icp as unknown as { Signer: SignerConstructor },
  algorand: algorand as unknown as { Signer: SignerConstructor },
  vechain: vechain as unknown as { Signer: SignerConstructor },
  tezos: tezos as unknown as { Signer: SignerConstructor },
  theta: theta as unknown as { Signer: SignerConstructor },
  multiversx: multiversx as unknown as { Signer: SignerConstructor },
  iota: iota as unknown as { Signer: SignerConstructor },
  neo: neo as unknown as { Signer: SignerConstructor },
  flow: flow as unknown as { Signer: SignerConstructor },
  icon: icon as unknown as { Signer: SignerConstructor },
  mina: mina as unknown as { Signer: SignerConstructor },
}

export const ALL_CHAIN_IDS: ChainId[] = Object.values(CHAIN_GROUPS).flat()

export interface DerivedAddress {
  address: string
  error?: string
}

export function useGlobalWallet() {
  const [mnemonic, setMnemonic] = useState(DEFAULT_MNEMONIC)
  const [addresses, setAddresses] = useState<Record<string, DerivedAddress>>({})
  const [deriving, setDeriving] = useState(false)

  const deriveAll = useCallback(async () => {
    if (!mnemonic.trim()) return
    setDeriving(true)
    const results: Record<string, DerivedAddress> = {}

    for (const chainId of ALL_CHAIN_IDS) {
      const config = CHAIN_CONFIGS[chainId]
      const module = CHAIN_MODULES[chainId]
      if (!module) continue
      try {
        const signer = new module.Signer()
        const pk = await signer.derivePrivateKey(mnemonic, config.hdPath)
        results[chainId] = { address: signer.getAddress(pk) }
      } catch (e) {
        results[chainId] = {
          address: '',
          error: e instanceof Error ? e.message : String(e),
        }
      }
    }

    setAddresses(results)
    setDeriving(false)
  }, [mnemonic])

  const copyAll = useCallback(async () => {
    if (Object.keys(addresses).length === 0) return
    const lines = ALL_CHAIN_IDS
      .filter(id => addresses[id]?.address)
      .map(id => `${CHAIN_CONFIGS[id].name}: ${addresses[id].address}`)
      .join('\n')
    await navigator.clipboard.writeText(lines)
  }, [addresses])

  return { mnemonic, setMnemonic, addresses, deriving, deriveAll, copyAll }
}
