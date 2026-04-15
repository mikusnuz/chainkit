export type ChainId =
  | 'ethereum'
  | 'bitcoin'
  | 'solana'
  | 'tron'
  | 'ton'
  | 'cosmos'
  | 'aptos'
  | 'sui'
  | 'near'
  | 'cardano'
  | 'xrp'
  | 'stellar'
  | 'starknet'
  | 'stacks'
  | 'kaia'
  | 'kaspa'
  | 'eos'
  | 'nostr'

export type ChainGroup = 'Secp256k1' | 'ED25519' | 'STARK'

export interface ChainConfig {
  name: string
  hdPath: string
  testnetRpc: string
  decimals: number
  symbol: string
  explorer: string
  group: ChainGroup
}

export const CHAIN_CONFIGS: Record<ChainId, ChainConfig> = {
  ethereum: {
    name: 'Ethereum',
    hdPath: "m/44'/60'/0'/0/0",
    testnetRpc: 'https://rpc.sepolia.org',
    decimals: 18,
    symbol: 'ETH',
    explorer: 'https://sepolia.etherscan.io',
    group: 'Secp256k1',
  },
  bitcoin: {
    name: 'Bitcoin',
    hdPath: "m/84'/0'/0'/0/0",
    testnetRpc: '',
    decimals: 8,
    symbol: 'BTC',
    explorer: 'https://mempool.space/testnet',
    group: 'Secp256k1',
  },
  tron: {
    name: 'Tron',
    hdPath: "m/44'/195'/0'/0/0",
    testnetRpc: 'https://api.shasta.trongrid.io',
    decimals: 6,
    symbol: 'TRX',
    explorer: 'https://shasta.tronscan.org',
    group: 'Secp256k1',
  },
  cosmos: {
    name: 'Cosmos',
    hdPath: "m/44'/118'/0'/0/0",
    testnetRpc: 'https://rpc.sentry-01.theta-testnet.polypore.xyz',
    decimals: 6,
    symbol: 'ATOM',
    explorer: '',
    group: 'Secp256k1',
  },
  xrp: {
    name: 'XRP',
    hdPath: "m/44'/144'/0'/0/0",
    testnetRpc: 'https://s.altnet.rippletest.net:51234',
    decimals: 6,
    symbol: 'XRP',
    explorer: 'https://testnet.xrpl.org',
    group: 'Secp256k1',
  },
  stacks: {
    name: 'Stacks',
    hdPath: "m/44'/5757'/0'/0/0",
    testnetRpc: 'https://api.testnet.hiro.so',
    decimals: 6,
    symbol: 'STX',
    explorer: 'https://explorer.hiro.so',
    group: 'Secp256k1',
  },
  kaia: {
    name: 'Kaia',
    hdPath: "m/44'/8217'/0'/0/0",
    testnetRpc: 'https://public-en-kairos.node.kaia.io',
    decimals: 18,
    symbol: 'KLAY',
    explorer: 'https://kairos.kaiascope.com',
    group: 'Secp256k1',
  },
  kaspa: {
    name: 'Kaspa',
    hdPath: "m/44'/111111'/0'/0/0",
    testnetRpc: '',
    decimals: 8,
    symbol: 'KAS',
    explorer: '',
    group: 'Secp256k1',
  },
  eos: {
    name: 'EOS',
    hdPath: "m/44'/194'/0'/0/0",
    testnetRpc: 'https://jungle4.cryptolions.io',
    decimals: 4,
    symbol: 'EOS',
    explorer: 'https://jungle4.eosq.eosnation.io',
    group: 'Secp256k1',
  },
  nostr: {
    name: 'Nostr',
    hdPath: "m/44'/1237'/0'/0/0",
    testnetRpc: '',
    decimals: 0,
    symbol: 'SAT',
    explorer: '',
    group: 'Secp256k1',
  },
  solana: {
    name: 'Solana',
    hdPath: "m/44'/501'/0'/0'",
    testnetRpc: 'https://api.devnet.solana.com',
    decimals: 9,
    symbol: 'SOL',
    explorer: 'https://explorer.solana.com',
    group: 'ED25519',
  },
  ton: {
    name: 'TON',
    hdPath: "m/44'/607'/0'",
    testnetRpc: 'https://testnet.toncenter.com/api/v2',
    decimals: 9,
    symbol: 'TON',
    explorer: 'https://testnet.tonviewer.com',
    group: 'ED25519',
  },
  aptos: {
    name: 'Aptos',
    hdPath: "m/44'/637'/0'/0'/0'",
    testnetRpc: 'https://fullnode.devnet.aptoslabs.com/v1',
    decimals: 8,
    symbol: 'APT',
    explorer: 'https://explorer.aptoslabs.com',
    group: 'ED25519',
  },
  sui: {
    name: 'Sui',
    hdPath: "m/44'/784'/0'/0'/0'",
    testnetRpc: 'https://fullnode.devnet.sui.io',
    decimals: 9,
    symbol: 'SUI',
    explorer: 'https://suiscan.xyz/devnet',
    group: 'ED25519',
  },
  near: {
    name: 'NEAR',
    hdPath: "m/44'/397'/0'",
    testnetRpc: 'https://rpc.testnet.near.org',
    decimals: 24,
    symbol: 'NEAR',
    explorer: 'https://testnet.nearblocks.io',
    group: 'ED25519',
  },
  cardano: {
    name: 'Cardano',
    hdPath: "m/1852'/1815'/0'/0/0",
    testnetRpc: '',
    decimals: 6,
    symbol: 'ADA',
    explorer: 'https://preview.cardanoscan.io',
    group: 'ED25519',
  },
  stellar: {
    name: 'Stellar',
    hdPath: "m/44'/148'/0'",
    testnetRpc: 'https://horizon-testnet.stellar.org',
    decimals: 7,
    symbol: 'XLM',
    explorer: 'https://stellar.expert/explorer/testnet',
    group: 'ED25519',
  },
  starknet: {
    name: 'StarkNet',
    hdPath: "m/44'/9004'/0'/0/0",
    testnetRpc: 'https://starknet-sepolia.public.blastapi.io',
    decimals: 18,
    symbol: 'STRK',
    explorer: 'https://sepolia.starkscan.co',
    group: 'STARK',
  },
}

export const CHAIN_GROUPS: Record<ChainGroup, ChainId[]> = {
  Secp256k1: ['ethereum', 'bitcoin', 'tron', 'cosmos', 'xrp', 'stacks', 'kaia', 'kaspa', 'eos', 'nostr'],
  ED25519: ['solana', 'ton', 'aptos', 'sui', 'near', 'cardano', 'stellar'],
  STARK: ['starknet'],
}

export const DEFAULT_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
