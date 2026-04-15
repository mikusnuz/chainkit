# ChainKit

Cross-chain abstraction SDK providing a unified API for 31 blockchains. One interface for wallet creation, transaction signing, balance queries, and token operations across all supported chains.

## Installation

```bash
npm install @chainkit/client @chainkit/ethereum @chainkit/bitcoin @chainkit/solana
# Install only the chains you need
```

## Quick Start

```typescript
import { createClient } from '@chainkit/client'
import { ethereum } from '@chainkit/ethereum'
import { bitcoin } from '@chainkit/bitcoin'
import { solana } from '@chainkit/solana'

const client = createClient({
  chains: {
    ethereum: {
      chain: ethereum,
      rpcs: ['https://eth-mainnet.g.alchemy.com/v2/...'],
      privateKey: '0x...',
    },
    bitcoin: {
      chain: bitcoin,
      rpcs: ['https://btc-rpc.example.com'],
    },
    solana: {
      chain: solana,
      rpcs: ['https://api.mainnet-beta.solana.com'],
      mnemonic: 'abandon abandon ...',
      hdPath: "m/44'/501'/0'/0'",
    },
  },
})

// Unified API across all chains
await client.ethereum.getBalance('0x...')
await client.bitcoin.getBalance('bc1...')
await client.solana.getBalance('HAgk...')

// Send transaction (only available when signer is configured)
await client.ethereum.send({ to: '0x...', amount: '1000000000000000000' })
```

## Packages

| Package | Description |
|---------|-------------|
| `@chainkit/core` | Shared interfaces, types, crypto utilities (BIP39/32), RPC manager |
| `@chainkit/client` | Unified client that composes chain packages |
| `@chainkit/ethereum` | Ethereum + all EVM chains |
| `@chainkit/bitcoin` | Bitcoin + UTXO forks |
| `@chainkit/solana` | Solana + SPL tokens |
| `@chainkit/tron` | Tron + TRC-20 tokens |
| `@chainkit/ton` | TON + Jetton tokens |
| `@chainkit/cosmos` | Cosmos Hub + IBC/Cosmos SDK chains |
| `@chainkit/aptos` | Aptos |
| `@chainkit/sui` | Sui |
| `@chainkit/near` | NEAR Protocol |
| `@chainkit/cardano` | Cardano |
| `@chainkit/xrp` | XRP Ledger |
| `@chainkit/stellar` | Stellar |
| `@chainkit/starknet` | StarkNet |
| `@chainkit/stacks` | Stacks |
| `@chainkit/kaia` | Kaia (prev Klaytn) + KIP-7 tokens |
| `@chainkit/kaspa` | Kaspa |
| `@chainkit/eos` | EOS / Vaulta |
| `@chainkit/nostr` | Nostr Assets |
| `@chainkit/polkadot` | Polkadot + Substrate parachains |
| `@chainkit/hedera` | Hedera |
| `@chainkit/filecoin` | Filecoin |
| `@chainkit/icp` | Internet Computer |
| `@chainkit/algorand` | Algorand |
| `@chainkit/vechain` | VeChain |
| `@chainkit/tezos` | Tezos |
| `@chainkit/theta` | Theta |
| `@chainkit/multiversx` | MultiversX |
| `@chainkit/iota` | IOTA |
| `@chainkit/neo` | Neo |
| `@chainkit/flow` | Flow |
| `@chainkit/icon` | Icon |

## Supported Chains & Exchange Coverage

ChainKit covers **~230/246 coins on Upbit KRW market (~93.5%)** and **~420/438 coins on Binance USDT spot (~95.9%)**.

Below is the full breakdown of which coins each package supports.

---

### @chainkit/ethereum (Secp256k1)

Covers Ethereum and **all EVM-compatible L1/L2 chains**. Any ERC-20 token or EVM chain is supported.

**Native:** ETH

**EVM L1/L2 chains covered (native tokens):**

| Chain | Token | Upbit | Binance |
|-------|-------|-------|---------|
| Polygon | POL (MATIC) | O | O |
| Arbitrum | ARB | O | O |
| Optimism | OP | O | O |
| BNB Smart Chain | BNB | - | O |
| Avalanche C-Chain | AVAX | O | O |
| Sonic (prev Fantom) | S (FTM) | - | O |
| Cronos | CRO | O | - |
| Mantle | MNT | O | - |
| Celo | CELO | O | O |
| Blast | BLAST | O | - |
| Base | (tokens below) | O | O |
| Linea | LINEA | O | O |
| zkSync | ZK | O | O |
| Zora | ZORA | O | - |
| Taiko | TAIKO | O | - |
| Berachain | BERA | O | O |
| Monad | MON | O | - |
| Manta | MANTA | - | O |
| Metis | METIS | - | O |
| Scroll | SCR | - | O |
| Ronin | RON | - | O |
| Moonbeam | GLMR | - | O |
| Moonriver | MOVR | - | O |
| KAVA | KAVA | O | O |
| Ethereum Classic | ETC | O | O |

**Major ERC-20 / EVM tokens:**

| Token | Name | Upbit | Binance |
|-------|------|-------|---------|
| USDT | Tether | O | O |
| USDC | USD Coin | O | O |
| LINK | Chainlink | O | O |
| UNI | Uniswap | O | O |
| AAVE | Aave | O | O |
| PEPE | Pepe | O | O |
| SHIB | Shiba Inu | O | O |
| MKR | Maker | O | O |
| LDO | Lido | O | O |
| ENS | ENS | O | O |
| ONDO | Ondo | O | O |
| IMX | Immutable | O | O |
| PENDLE | Pendle | O | O |
| GRT | The Graph | O | O |
| SNX | Synthetix | O | O |
| CRV | Curve | O | O |
| COMP | Compound | O | O |
| 1INCH | 1inch | O | O |
| AXS | Axie Infinity | O | O |
| SAND | The Sandbox | O | O |
| MANA | Decentraland | O | O |
| ENJ | Enjin | O | O |
| CHZ | Chiliz | O | O |
| BAT | Basic Attention | O | O |
| WLD | Worldcoin | O | O |
| ENA | Ethena | O | O |
| ETHFI | EtherFi | O | O |
| BLUR | Blur | O | O |
| MASK | Mask Network | O | O |
| FLOKI | Floki | O | O |
| YFI | Yearn | O | O |
| SUSHI | SushiSwap | O | O |
| ANKR | Ankr | O | O |
| SKL | SKALE | O | O |
| STORJ | Storj | O | O |
| KNC | Kyber Network | O | O |
| ZRX | 0x | O | O |
| LPT | Livepeer | O | O |
| GTC | Gitcoin | O | O |
| EIGEN | EigenLayer | O | O |
| ZRO | LayerZero | O | O |
| ARKM | Arkham | O | O |
| ID | SPACE ID | O | O |
| CYBER | Cyber | O | O |
| ORBS | Orbs | O | - |
| PUNDIX | Pundi X | O | - |
| IQ | IQ | O | - |
| AXL | Axelar | O | O |
| SAFE | Safe | O | O |
| COW | CoW Protocol | O | O |
| W | Wormhole | O | O |
| FET | Fetch.ai | O | O |
| RSR | Reserve Rights | O | O |
| GMX | GMX | - | O |
| SSV | SSV Network | - | O |
| CVX | Convex | - | O |
| RPL | Rocket Pool | - | O |
| SNT | Status | O | - |
| CVC | Civic | O | - |
| MTL | Metal | O | - |
| POWR | Power Ledger | O | - |
| WBTC | Wrapped Bitcoin | O | O |
| PAXG | PAX Gold | - | O |

**Plus 50+ additional ERC-20 tokens.** Any token deployed on Ethereum or EVM chains is supported.

**Estimated total: ~120+ coins**

---

### @chainkit/bitcoin (Secp256k1)

Covers Bitcoin and UTXO-model forks sharing Bitcoin's transaction primitives.

**Native:** BTC

| Token | Chain | Upbit | Binance |
|-------|-------|-------|---------|
| BTC | Bitcoin | O | O |
| DOGE | Dogecoin | O | O |
| BCH | Bitcoin Cash | O | O |
| LTC | Litecoin | - | O |
| BSV | Bitcoin SV | O | - |
| ORDI | Bitcoin (BRC-20) | - | O |
| 1000SATS | Bitcoin (BRC-20) | - | O |

**Note:** XEC (eCash), DASH, DGB, RVN, ZEC, DCR, PIVX, XVG are Bitcoin-derived UTXO chains that share similar primitives but may need address format adjustments.

**Estimated total: ~14 coins**

---

### @chainkit/solana (ED25519)

Covers Solana and all SPL tokens.

**Native:** SOL

| Token | Name | Upbit | Binance |
|-------|------|-------|---------|
| SOL | Solana | O | O |
| BONK | Bonk | O | O |
| JTO | Jito | O | O |
| JUP | Jupiter | O | O |
| PYTH | Pyth | O | O |
| RENDER | Render | O | O |
| RAY | Raydium | O | O |
| ME | Magic Eden | O | O |
| TRUMP | TRUMP | O | O |
| PENGU | Pudgy Penguins | O | O |
| MOODENG | Moo Deng | O | O |
| MEW | cat in a dogs world | O | O |
| LAYER | Solayer | O | O |
| PUMP | Pump.fun | O | O |
| DOOD | Doodles | O | O |
| WIF | dogwifhat | - | O |
| DRIFT | Drift | O | - |
| SONIC | Sonic SVM | O | - |
| ORCA | Orca | O | O |
| BOME | BOOK OF MEME | - | O |
| PNUT | Peanut | - | O |
| TNSR | Tensor | - | O |
| FIDA | Bonfida | - | O |
| NEIRO | Neiro | - | O |

**Plus additional SPL tokens.** Any token on Solana is supported.

**Estimated total: ~32+ coins**

---

### @chainkit/tron (Secp256k1)

Covers Tron and all TRC-20 tokens.

**Native:** TRX

| Token | Name | Upbit | Binance |
|-------|------|-------|---------|
| TRX | Tron | O | O |
| BTT | BitTorrent | O | O |
| JST | JUST | O | O |
| SUN | Sun | O | O |
| WIN | WINkLink | - | O |
| USDT | Tether (TRC-20) | O | O |

**Estimated total: ~6 coins**

---

### @chainkit/ton (ED25519)

Covers TON and Jetton tokens.

**Native:** TON

| Token | Name | Upbit | Binance |
|-------|------|-------|---------|
| TON | TON | - | O |
| NOT | Notcoin | - | O |
| DOGS | DOGS | - | O |
| HMSTR | Hamster Kombat | - | O |
| CATI | Catizen | - | O |

**Estimated total: ~5 coins**

---

### @chainkit/cosmos (Secp256k1)

Covers Cosmos Hub and all Cosmos SDK / IBC-connected chains. Supports custom bech32 prefixes.

**Native:** ATOM

| Token | Chain | Upbit | Binance |
|-------|-------|-------|---------|
| ATOM | Cosmos Hub | O | O |
| INJ | Injective | O | O |
| SEI | Sei | O | O |
| TIA | Celestia | O | O |
| OM | MANTRA | O | O |
| AKT | Akash | O | - |
| DYDX | dYdX v4 | - | O |
| OSMO | Osmosis | - | O |
| RUNE | THORChain | - | O |
| LUNA | Terra | - | O |
| LUNC | Terra Classic | - | O |
| SAGA | Saga | - | O |
| DYM | Dymension | - | O |
| INIT | Initia | - | O |
| BAND | Band Protocol | - | O |
| SCRT | Secret | - | O |
| KAVA | Kava (also EVM) | O | O |
| STEEM | Steem | O | O |
| HIVE | Hive | O | O |

**Note:** Any Cosmos SDK chain with IBC support can use this package with a custom bech32 prefix.

**Estimated total: ~21 coins**

---

### @chainkit/kaia (Secp256k1)

Covers Kaia (prev Klaytn) and KIP-7 tokens. EVM-compatible with `klay_` RPC prefix.

**Native:** KAIA (KLAY)

| Token | Name | Upbit | Binance |
|-------|------|-------|---------|
| KAIA | Kaia | - | O |
| BORA | BORA | O | - |
| MBL | MovieBloc | O | O |
| MLK | MiL.k | O | - |
| MVL | MVL | O | - |
| MED | MediBloc | O | - |
| META | Metadium | O | - |
| MOC | Moss Coin | O | - |
| CBK | Cobak | O | - |
| DKA | dKargo | O | - |
| HUNT | Hunt | O | - |

**Estimated total: ~13 coins**

---

### @chainkit/polkadot (SR25519)

Covers Polkadot, Kusama, and all Substrate-based parachains. Supports custom SS58 network prefixes.

**Native:** DOT

| Token | Chain | Upbit | Binance |
|-------|-------|-------|---------|
| DOT | Polkadot | O | O |
| KSM | Kusama | - | O |
| ASTR | Astar | O | O |
| GLMR | Moonbeam | - | O |
| MOVR | Moonriver | - | O |
| PHA | Phala | - | O |
| POLYX | Polymesh | O | O |
| CFG | Centrifuge | O | O |

**Estimated total: ~8 coins**

---

### @chainkit/xrp (Secp256k1)

**Native:** XRP

| Token | Name | Upbit | Binance |
|-------|------|-------|---------|
| XRP | XRP | O | O |
| RLUSD | Ripple USD | - | O |

**Estimated total: ~2 coins**

---

### @chainkit/sui (ED25519)

**Native:** SUI

| Token | Name | Upbit | Binance |
|-------|------|-------|---------|
| SUI | Sui | O | O |
| WAL | Walrus | O | O |
| DEEP | DeepBook | O | O |
| CETUS | Cetus | - | O |
| HAEDAL | Haedal | - | O |

**Estimated total: ~5 coins**

---

### @chainkit/aptos (ED25519)

**Native:** APT

| Token | Upbit | Binance |
|-------|-------|---------|
| APT | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/near (ED25519)

**Native:** NEAR

| Token | Upbit | Binance |
|-------|-------|---------|
| NEAR | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/cardano (ED25519)

**Native:** ADA

| Token | Upbit | Binance |
|-------|-------|---------|
| ADA | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/stellar (ED25519)

**Native:** XLM

| Token | Upbit | Binance |
|-------|-------|---------|
| XLM | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/starknet (STARK)

**Native:** STRK

| Token | Upbit | Binance |
|-------|-------|---------|
| STRK | - | O |

**Estimated total: ~1 coin**

---

### @chainkit/stacks (Secp256k1)

**Native:** STX

| Token | Upbit | Binance |
|-------|-------|---------|
| STX | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/eos (Secp256k1)

**Native:** A (Vaulta, prev EOS)

| Token | Upbit | Binance |
|-------|-------|---------|
| A (EOS) | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/kaspa (Secp256k1)

**Native:** KAS

Not listed on Upbit KRW or Binance USDT spot as of April 2026.

**Estimated total: 0 coins (on target exchanges)**

---

### @chainkit/nostr (Secp256k1)

Nostr is a relay protocol, not a blockchain. No tradeable tokens on exchanges.

**Estimated total: 0 coins**

---

### @chainkit/hedera (ED25519)

**Native:** HBAR

| Token | Upbit | Binance |
|-------|-------|---------|
| HBAR | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/filecoin (Secp256k1)

**Native:** FIL

| Token | Upbit | Binance |
|-------|-------|---------|
| FIL | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/icp (ED25519)

**Native:** ICP

| Token | Upbit | Binance |
|-------|-------|---------|
| ICP | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/algorand (ED25519)

**Native:** ALGO

| Token | Upbit | Binance |
|-------|-------|---------|
| ALGO | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/vechain (Secp256k1)

**Native:** VET

| Token | Upbit | Binance |
|-------|-------|---------|
| VET | - | O |
| VTHO | - | O |

**Estimated total: ~2 coins**

---

### @chainkit/tezos (ED25519)

**Native:** XTZ

| Token | Upbit | Binance |
|-------|-------|---------|
| XTZ | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/theta (Secp256k1)

**Native:** THETA

| Token | Upbit | Binance |
|-------|-------|---------|
| THETA | O | O |
| TFUEL | O | O |

**Estimated total: ~2 coins**

---

### @chainkit/multiversx (ED25519)

**Native:** EGLD

| Token | Upbit | Binance |
|-------|-------|---------|
| EGLD | - | O |

**Estimated total: ~1 coin**

---

### @chainkit/iota (ED25519)

**Native:** IOTA

| Token | Upbit | Binance |
|-------|-------|---------|
| IOTA | - | O |

**Estimated total: ~1 coin**

---

### @chainkit/neo (Secp256r1)

**Native:** NEO

| Token | Upbit | Binance |
|-------|-------|---------|
| NEO | - | O |
| GAS | - | O |

**Estimated total: ~2 coins**

---

### @chainkit/flow (ECDSA_P256)

**Native:** FLOW

| Token | Upbit | Binance |
|-------|-------|---------|
| FLOW | O | O |

**Estimated total: ~1 coin**

---

### @chainkit/icon (Secp256k1)

**Native:** ICX

| Token | Upbit | Binance |
|-------|-------|---------|
| ICX | O | O |

**Estimated total: ~1 coin**

---

## Signature Algorithm Categories

| Category | Curve | Chains |
|----------|-------|--------|
| **Secp256k1** | secp256k1 ECDSA | Ethereum, Bitcoin, Tron, Cosmos, XRP, Stacks, Kaia, Kaspa, EOS, Nostr, Filecoin, VeChain, Theta, Icon |
| **ED25519** | Ed25519 EdDSA | Solana, TON, Aptos, Sui, NEAR, Cardano, Stellar, Hedera, ICP, Algorand, Tezos, MultiversX, IOTA |
| **SR25519** | Schnorrkel/Ristretto | Polkadot |
| **Secp256r1** | NIST P-256 ECDSA | Neo |
| **ECDSA_P256** | ECDSA P-256 | Flow |
| **STARK** | Stark curve | StarkNet |

## Architecture

```
@chainkit/client (unified API)
  |
  +-- @chainkit/core (interfaces, types, crypto, RPC manager)
  |
  +-- @chainkit/<chain> (signer + provider per chain)
        |
        +-- signer.ts   (offline: key generation, signing)
        +-- provider.ts  (online: RPC queries, broadcasting)
        +-- types.ts     (chain-specific types)
```

## Features

- Unified `getBalance()`, `send()`, `getTransaction()` across all chains
- Offline signer (BIP39 mnemonic, BIP32/44 HD derivation, keystore)
- Multi-RPC with failover, round-robin, and fastest strategies
- Read-only mode (no private key = no write methods at type level)
- Chain-specific capabilities: `ContractCapable`, `TokenCapable`, `UtxoCapable`, `SubscriptionCapable`
- Cross-platform: Node.js, browser, React Native
- ESM + CJS dual build
- Zero native dependencies (pure JS crypto via @noble/@scure)

## License

MIT
