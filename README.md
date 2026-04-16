# ChainKit

Cross-chain abstraction SDK. One unified API for 30 blockchains -- wallet creation, address validation, balance queries, transaction signing, and token operations.

Zero external chain SDK dependencies. Pure JavaScript crypto via @noble/@scure.

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

const client = await createClient({
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

## Unified API

### ChainSigner (Offline -- all 30 chains)

Every chain signer implements these methods identically:

```typescript
import { EthereumSigner } from '@chainkit/ethereum'
import { BitcoinSigner } from '@chainkit/bitcoin'
import { SolanaSigner } from '@chainkit/solana'

// Works the same on ALL chains
const signer = new EthereumSigner()

// Mnemonic
const mnemonic = signer.generateMnemonic()        // 12 words (128 bits)
signer.generateMnemonic(256)                       // 24 words
signer.validateMnemonic(mnemonic)                  // true/false

// Key derivation
const pk = await signer.derivePrivateKey(mnemonic, "m/44'/60'/0'/0/0")

// Address
const address = signer.getAddress(pk)
signer.validateAddress(address)                    // true
signer.validateAddress('invalid')                  // false

// Sign transaction (unified params object)
const signed = await signer.signTransaction({
  privateKey: pk,
  tx: {
    to: '0x...',
    value: '1000000000000000000',
    fee: { gasLimit: '0x5208', maxFeePerGas: '0x2540be400' },
    extra: { chainId: 1 },
  },
})

// Sign message
const sig = await signer.signMessage({
  privateKey: pk,
  message: 'Hello ChainKit',
})
```

### ChainProvider (Online -- all 30 chains)

```typescript
import { EthereumProvider } from '@chainkit/ethereum'

const provider = new EthereumProvider({
  endpoints: ['https://eth-mainnet.example.com'],
  strategy: 'failover',    // 'failover' | 'round-robin' | 'fastest'
  timeout: 10000,
  retries: 2,
})

// Balance
const balance = await provider.getBalance('0x...')
// { address: '0x...', amount: '1000000000000000000', decimals: 18, symbol: 'ETH' }

// Nonce / sequence number
const nonce = await provider.getNonce('0x...')

// Transaction info
const tx = await provider.getTransaction('0x...')

// Block info
const block = await provider.getBlock(12345)

// Fee estimation (slow / average / fast)
const fee = await provider.estimateFee()
// { slow: '...', average: '...', fast: '...', unit: 'wei' }

// Broadcast
const txHash = await provider.broadcastTransaction(signedTxHex)

// Chain info
const info = await provider.getChainInfo()
// { chainId: '1', name: 'Ethereum Mainnet', symbol: 'ETH', decimals: 18, testnet: false, blockHeight: 12345 }
```

### Capabilities (chain-specific extensions)

Not all chains support all features. Capabilities are type-safe extensions:

#### ContractCapable

```typescript
// EVM, Solana, Cosmos, Tron, TON, Aptos, Sui, NEAR, Tezos, etc.
await provider.callContract(contractAddress, 'balanceOf(address)', ['0x...'])
await provider.estimateGas(contractAddress, 'transfer(address,uint256)', ['0x...', 1000n])
```

#### TokenCapable

```typescript
// Get single token balance
await provider.getTokenBalance(address, tokenAddress)

// Get multiple token balances at once
await provider.getMultipleTokenBalances(address, [token1, token2, token3])

// Get token metadata (name, symbol, decimals, totalSupply)
await provider.getTokenMetadata(tokenAddress)
```

#### UtxoCapable

```typescript
// Bitcoin, Cardano (eUTXO)
await provider.getUtxos(address)
await provider.selectUtxos(address, '100000')  // coin selection
```

#### SubscriptionCapable

```typescript
// Poll-based subscriptions
const unsubscribe = await provider.subscribeBlocks(blockNumber => { ... })
const unsubscribe = await provider.subscribeTransactions(address, tx => { ... })
```

#### EvmSignerCapable (EIP-712)

```typescript
// Ethereum, Kaia, VeChain, Theta, Icon
const sig = await signer.signTypedData({
  privateKey: pk,
  domain: { name: 'MyDApp', version: '1', chainId: 1 },
  types: {
    Order: [
      { name: 'maker', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  primaryType: 'Order',
  message: { maker: '0x...', amount: '1000' },
})
```

#### Dual-Token Chains

```typescript
// VeChain (VET/VTHO), Theta (THETA/TFUEL), Neo (NEO/GAS), EOS (CPU/NET/RAM)
await provider.getBalance(address)             // primary token
await provider.getNativeBalances?.(address)     // all native tokens
```

### Unified Client

```typescript
import { createClient } from '@chainkit/client'
import { ethereum } from '@chainkit/ethereum'
import { bitcoin } from '@chainkit/bitcoin'

const client = await createClient({
  chains: {
    ethereum: {
      chain: ethereum,
      rpcs: ['https://...'],
      privateKey: '0x...',     // optional: omit for read-only
    },
    bitcoin: {
      chain: bitcoin,
      rpcs: ['https://...'],
    },
  },
})

// Read (all chains)
await client.ethereum.getBalance('0x...')
await client.ethereum.getTransaction('0x...')
await client.ethereum.getBlock(12345)
await client.ethereum.estimateFee()
await client.ethereum.getChainInfo()

// Write (only when privateKey or mnemonic provided)
await client.ethereum.send({ to: '0x...', amount: '1000' })
await client.ethereum.signTransaction({
  privateKey: '0x...',
  tx: { to: '0x...', value: '1000' },
})
await client.ethereum.signMessage({
  privateKey: '0x...',
  message: 'Hello',
})
await client.ethereum.getAddress()

// Access underlying signer/provider directly
client.ethereum.provider   // ChainProvider instance
client.ethereum.signer     // ChainSigner instance (only when key provided)
```

## Signature Algorithm Categories

| Category | Curve | Chains |
|----------|-------|--------|
| Secp256k1 | secp256k1 ECDSA | Ethereum, Bitcoin, Tron, Cosmos, XRP, Stacks, Kaia, EOS, Filecoin, VeChain, Theta, Icon |
| ED25519 | Ed25519 EdDSA | Solana, TON, Aptos, Sui, NEAR, Cardano, Stellar, Hedera, ICP, Algorand, Tezos, MultiversX, IOTA |
| SR25519 | Schnorrkel/Ristretto | Polkadot |
| STARK | Stark curve | StarkNet |
| Secp256r1 | NIST P-256 ECDSA | Neo |
| ECDSA_P256 | ECDSA P-256 | Flow |
| Pasta | Pallas curve Schnorr | Mina |

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
| `@chainkit/eos` | EOS / Vaulta |
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
| `@chainkit/mina` | Mina |

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

### @chainkit/mina (Pasta)

**Native:** MINA

| Token | Upbit | Binance |
|-------|-------|---------|
| MINA | - | O |

**Estimated total: ~1 coin**

---

## Architecture

```
@chainkit/client (unified multi-chain client)
  |
  +-- createClient() --> ReadOnlyChainInstance (no key = read-only)
  |                  --> FullChainInstance     (key provided = read+write)
  |
  +-- @chainkit/core
  |     +-- ChainSigner interface   (generateMnemonic, derivePrivateKey, getAddress, signTransaction, signMessage, validateAddress)
  |     +-- ChainProvider interface (getBalance, getTransaction, getBlock, getNonce, estimateFee, broadcastTransaction, getChainInfo)
  |     +-- Capabilities            (ContractCapable, TokenCapable, UtxoCapable, SubscriptionCapable, EvmSignerCapable)
  |     +-- RpcManager              (failover, round-robin, fastest)
  |     +-- Crypto utilities        (BIP39 mnemonic, BIP32 HD derivation via @scure/bip39 + @noble/hashes)
  |
  +-- @chainkit/<chain>
        +-- signer.ts   (offline: key generation, address derivation, tx signing, message signing)
        +-- provider.ts  (online: RPC queries, balance, blocks, broadcasting, token ops)
        +-- types.ts     (chain-specific types)
```

## RPC Strategies

```typescript
// Failover: try endpoints in order, fall back on failure
{ endpoints: ['rpc1', 'rpc2'], strategy: 'failover' }

// Round-robin: distribute requests across endpoints
{ endpoints: ['rpc1', 'rpc2', 'rpc3'], strategy: 'round-robin' }

// Fastest: race all endpoints, use the first successful response
{ endpoints: ['rpc1', 'rpc2'], strategy: 'fastest' }
```

All strategies include automatic retry (configurable `retries`, default 2) and per-request timeout (configurable `timeout`, default 10000ms). JSON-RPC errors are not retried -- only network/timeout failures trigger retries.

## Key Management

- **BIP39 mnemonic**: 12 or 24 word phrases (128/256 bit entropy)
- **BIP32/44 HD derivation**: Standard derivation paths per chain (e.g., `m/44'/60'/0'/0/0` for Ethereum)
- **Raw private key**: Direct hex-encoded private key input
- **WIF**: Bitcoin Wallet Import Format
- **Address validation**: Per-chain format validation (EIP-55 checksum, bech32, base58, base58check, SS58, etc.)

## Testnet Verification

26 chains verified with real testnet RPC connectivity and address derivation:

| Chain | Testnet | Status |
|-------|---------|--------|
| Ethereum | Sepolia | Verified |
| Bitcoin | Testnet | Verified |
| Solana | Devnet | Verified |
| Tron | Shasta | Verified |
| TON | Testnet | Verified |
| Cosmos | Theta Testnet | Verified |
| Aptos | Devnet | Verified |
| Sui | Devnet | Verified |
| NEAR | Testnet | Verified |
| XRP | Testnet | Verified |
| Stellar | Testnet | Verified |
| Stacks | Testnet | Verified |
| Kaia | Kairos | Verified |
| EOS | Jungle4 | Verified |
| Cardano | Preview | Verified |
| StarkNet | Sepolia | Verified |
| Hedera | Testnet | Verified |
| Filecoin | Calibration | Verified |
| ICP | Mainnet Rosetta | Verified |
| Algorand | Testnet | Verified |
| VeChain | Testnet | Verified |
| Tezos | Ghostnet | Verified |
| Theta | Testnet | Verified |
| MultiversX | Testnet | Verified |
| Polkadot | Westend | Verified |
| Mina | Devnet | Verified |

## License

MIT
