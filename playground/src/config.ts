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
  | 'eos'
  | 'polkadot'
  | 'hedera'
  | 'filecoin'
  | 'icp'
  | 'algorand'
  | 'vechain'
  | 'tezos'
  | 'theta'
  | 'multiversx'
  | 'iota'
  | 'neo'
  | 'flow'
  | 'icon'
  | 'mina'

export type ChainGroup = 'Secp256k1' | 'ED25519' | 'SR25519' | 'Secp256r1' | 'ECDSA_P256' | 'STARK' | 'Pasta'

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
  eos: {
    name: 'EOS',
    hdPath: "m/44'/194'/0'/0/0",
    testnetRpc: 'https://jungle4.cryptolions.io',
    decimals: 4,
    symbol: 'EOS',
    explorer: 'https://jungle4.eosq.eosnation.io',
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
  polkadot: {
    name: 'Polkadot',
    hdPath: "m/44'/354'/0'/0'/0'",
    testnetRpc: 'wss://westend-rpc.polkadot.io',
    decimals: 10,
    symbol: 'DOT',
    explorer: 'https://westend.subscan.io',
    group: 'SR25519',
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
  hedera: {
    name: 'Hedera',
    hdPath: "m/44'/3030'/0'/0'/0'",
    testnetRpc: 'https://testnet.mirrornode.hedera.com',
    decimals: 8,
    symbol: 'HBAR',
    explorer: 'https://hashscan.io/testnet',
    group: 'ED25519',
  },
  filecoin: {
    name: 'Filecoin',
    hdPath: "m/44'/461'/0'/0/0",
    testnetRpc: 'https://api.calibration.node.glif.io/rpc/v1',
    decimals: 18,
    symbol: 'FIL',
    explorer: 'https://calibration.filfox.info',
    group: 'Secp256k1',
  },
  icp: {
    name: 'ICP',
    hdPath: "m/44'/223'/0'/0'/0'",
    testnetRpc: 'https://rosetta-api.internetcomputer.org',
    decimals: 8,
    symbol: 'ICP',
    explorer: 'https://dashboard.internetcomputer.org',
    group: 'ED25519',
  },
  algorand: {
    name: 'Algorand',
    hdPath: "m/44'/283'/0'/0'/0'",
    testnetRpc: 'https://testnet-api.algonode.cloud',
    decimals: 6,
    symbol: 'ALGO',
    explorer: 'https://testnet.explorer.perawallet.app',
    group: 'ED25519',
  },
  vechain: {
    name: 'VeChain',
    hdPath: "m/44'/818'/0'/0/0",
    testnetRpc: 'https://testnet.veblocks.net',
    decimals: 18,
    symbol: 'VET',
    explorer: 'https://explore-testnet.vechain.org',
    group: 'Secp256k1',
  },
  tezos: {
    name: 'Tezos',
    hdPath: "m/44'/1729'/0'/0'",
    testnetRpc: 'https://ghostnet.tezos.marigold.dev',
    decimals: 6,
    symbol: 'XTZ',
    explorer: 'https://ghostnet.tzkt.io',
    group: 'ED25519',
  },
  theta: {
    name: 'Theta',
    hdPath: "m/44'/500'/0'/0/0",
    testnetRpc: 'https://eth-rpc-api-testnet.thetatoken.org/rpc',
    decimals: 18,
    symbol: 'THETA',
    explorer: 'https://testnet-explorer.thetatoken.org',
    group: 'Secp256k1',
  },
  multiversx: {
    name: 'MultiversX',
    hdPath: "m/44'/508'/0'/0'/0'",
    testnetRpc: 'https://testnet-api.multiversx.com',
    decimals: 18,
    symbol: 'EGLD',
    explorer: 'https://testnet-explorer.multiversx.com',
    group: 'ED25519',
  },
  iota: {
    name: 'IOTA',
    hdPath: "m/44'/4218'/0'/0'/0'",
    testnetRpc: 'https://api.testnet.shimmer.network',
    decimals: 6,
    symbol: 'IOTA',
    explorer: 'https://explorer.shimmer.network/testnet',
    group: 'ED25519',
  },
  neo: {
    name: 'Neo',
    hdPath: "m/44'/888'/0'/0/0",
    testnetRpc: 'https://testnet1.neo.coz.io:443',
    decimals: 0,
    symbol: 'NEO',
    explorer: 'https://testnet.neotube.io',
    group: 'Secp256r1',
  },
  flow: {
    name: 'Flow',
    hdPath: "m/44'/539'/0'/0/0",
    testnetRpc: 'https://rest-testnet.onflow.org',
    decimals: 8,
    symbol: 'FLOW',
    explorer: 'https://testnet.flowdiver.io',
    group: 'ECDSA_P256',
  },
  icon: {
    name: 'Icon',
    hdPath: "m/44'/74'/0'/0/0",
    testnetRpc: 'https://lisbon.net.solidwallet.io/api/v3',
    decimals: 18,
    symbol: 'ICX',
    explorer: 'https://lisbon.tracker.solidwallet.io',
    group: 'Secp256k1',
  },
  mina: {
    name: 'Mina',
    hdPath: "m/44'/12586'/0'/0/0",
    testnetRpc: 'https://devnet.minaprotocol.network/graphql',
    decimals: 9,
    symbol: 'MINA',
    explorer: 'https://minascan.io/devnet',
    group: 'Pasta',
  },
}

export const CHAIN_GROUPS: Record<ChainGroup, ChainId[]> = {
  Secp256k1: ['ethereum', 'bitcoin', 'tron', 'cosmos', 'xrp', 'stacks', 'kaia', 'eos', 'filecoin', 'vechain', 'theta', 'icon'],
  ED25519: ['solana', 'ton', 'aptos', 'sui', 'near', 'cardano', 'stellar', 'hedera', 'icp', 'algorand', 'tezos', 'multiversx', 'iota'],
  SR25519: ['polkadot'],
  Secp256r1: ['neo'],
  ECDSA_P256: ['flow'],
  STARK: ['starknet'],
  Pasta: ['mina'],
}

export const DEFAULT_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
