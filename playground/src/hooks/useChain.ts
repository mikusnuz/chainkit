import { useState, useCallback, useRef } from 'react'
import type { ChainId, ChainConfig } from '../config'
import { CHAIN_CONFIGS } from '../config'

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
import { kaspa } from '@chainkit/kaspa'
import { eos } from '@chainkit/eos'
import { nostr } from '@chainkit/nostr'
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
import type { RpcManagerConfig } from '@chainkit/core'

type SignerConstructor = new () => { derivePrivateKey: (mnemonic: string, path: string) => Promise<string>; getAddress: (pk: string) => string }
type ProviderConstructor = new (config: RpcManagerConfig) => {
  getBalance: (address: string) => Promise<unknown>
  getChainInfo: () => Promise<unknown>
  getTransaction: (hash: string) => Promise<unknown>
  broadcastTransaction: (tx: string) => Promise<string>
}

const CHAIN_MODULES: Record<ChainId, { Signer: SignerConstructor; Provider: ProviderConstructor }> = {
  ethereum: ethereum as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  bitcoin: bitcoin as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  solana: solana as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  tron: tron as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  ton: ton as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  cosmos: cosmos as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  aptos: aptos as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  sui: sui as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  near: near as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  xrp: xrp as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  stellar: stellar as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  starknet: starknet as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  stacks: stacks as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  kaia: kaia as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  kaspa: kaspa as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  eos: eos as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  nostr: nostr as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  cardano: cardano as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  polkadot: polkadot as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  hedera: hedera as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  filecoin: filecoin as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  icp: icp as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  algorand: algorand as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  vechain: vechain as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  tezos: tezos as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  theta: theta as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  multiversx: multiversx as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  iota: iota as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  neo: neo as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  flow: flow as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
  icon: icon as unknown as { Signer: SignerConstructor; Provider: ProviderConstructor },
}

export interface WalletState {
  privateKey: string | null
  address: string | null
  loading: boolean
  error: string | null
}

export interface ProviderState {
  connected: boolean
  connecting: boolean
  error: string | null
  rpcUrl: string
  strategy: 'failover' | 'round-robin' | 'fastest'
}

export interface ActionResult {
  loading: boolean
  data: unknown
  error: string | null
}

export function useChain(chainId: ChainId) {
  const config: ChainConfig = CHAIN_CONFIGS[chainId]
  const module = CHAIN_MODULES[chainId]

  const [wallet, setWallet] = useState<WalletState>({
    privateKey: null,
    address: null,
    loading: false,
    error: null,
  })

  const [providerState, setProviderState] = useState<ProviderState>({
    connected: false,
    connecting: false,
    error: null,
    rpcUrl: config.testnetRpc,
    strategy: 'failover',
  })

  const [balanceResult, setBalanceResult] = useState<ActionResult>({ loading: false, data: null, error: null })
  const [chainInfoResult, setChainInfoResult] = useState<ActionResult>({ loading: false, data: null, error: null })
  const [txResult, setTxResult] = useState<ActionResult>({ loading: false, data: null, error: null })
  const [sendResult, setSendResult] = useState<ActionResult>({ loading: false, data: null, error: null })

  const providerRef = useRef<InstanceType<ProviderConstructor> | null>(null)

  const deriveWallet = useCallback(async (mnemonic: string, path: string) => {
    setWallet(prev => ({ ...prev, loading: true, error: null }))
    try {
      const signer = new module.Signer()
      const pk = await signer.derivePrivateKey(mnemonic, path)
      const address = signer.getAddress(pk)
      setWallet({ privateKey: pk, address, loading: false, error: null })
    } catch (err) {
      setWallet(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }, [module])

  const connect = useCallback(async (rpcUrl: string, strategy: 'failover' | 'round-robin' | 'fastest') => {
    if (!rpcUrl) {
      setProviderState(prev => ({ ...prev, error: 'No testnet RPC configured for this chain.' }))
      return
    }
    setProviderState(prev => ({ ...prev, connecting: true, error: null, rpcUrl, strategy }))
    try {
      const provider = new module.Provider({ endpoints: [rpcUrl], strategy })
      providerRef.current = provider
      // Test connection with a simple call
      await (provider as unknown as { getChainInfo: () => Promise<unknown> }).getChainInfo()
      setProviderState(prev => ({ ...prev, connected: true, connecting: false }))
    } catch (err) {
      setProviderState(prev => ({
        ...prev,
        connected: false,
        connecting: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }, [module])

  const getBalance = useCallback(async (address: string) => {
    if (!providerRef.current) return
    setBalanceResult({ loading: true, data: null, error: null })
    try {
      const result = await providerRef.current.getBalance(address)
      setBalanceResult({ loading: false, data: result, error: null })
    } catch (err) {
      setBalanceResult({ loading: false, data: null, error: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const getChainInfo = useCallback(async () => {
    if (!providerRef.current) return
    setChainInfoResult({ loading: true, data: null, error: null })
    try {
      const result = await (providerRef.current as unknown as { getChainInfo: () => Promise<unknown> }).getChainInfo()
      setChainInfoResult({ loading: false, data: result, error: null })
    } catch (err) {
      setChainInfoResult({ loading: false, data: null, error: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const getTransaction = useCallback(async (hash: string) => {
    if (!providerRef.current) return
    setTxResult({ loading: true, data: null, error: null })
    try {
      const result = await providerRef.current.getTransaction(hash)
      setTxResult({ loading: false, data: result, error: null })
    } catch (err) {
      setTxResult({ loading: false, data: null, error: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const sendTransaction = useCallback(async (signedTx: string) => {
    if (!providerRef.current) return
    setSendResult({ loading: true, data: null, error: null })
    try {
      const result = await providerRef.current.broadcastTransaction(signedTx)
      setSendResult({ loading: false, data: result, error: null })
    } catch (err) {
      setSendResult({ loading: false, data: null, error: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  return {
    config,
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
  }
}
