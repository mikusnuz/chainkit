# ChainKit

Cross-chain wallet SDK. One unified API for 30 blockchains -- wallet creation, address validation, balance queries, transaction signing, and token operations.

Zero external chain SDK dependencies. Pure JavaScript crypto via @noble/@scure.

## Installation

```bash
# Install the client and only the chains you need
npm install @chainkit/client @chainkit/ethereum @chainkit/bitcoin @chainkit/solana

# Full list of chain packages:
# @chainkit/{ethereum,bitcoin,solana,tron,ton,cosmos,aptos,sui,near,cardano,
#   xrp,stellar,starknet,stacks,kaia,eos,polkadot,hedera,filecoin,icp,
#   algorand,vechain,tezos,theta,multiversx,iota,neo,flow,icon,mina}
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
      rpcs: ['https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY'],
      privateKey: '0x...',
    },
    bitcoin: {
      chain: bitcoin,
      rpcs: ['https://btc-rpc.example.com'],
    },
    solana: {
      chain: solana,
      rpcs: ['https://api.mainnet-beta.solana.com'],
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      hdPath: "m/44'/501'/0'/0'",
    },
  },
})

// Read (all chains)
await client.ethereum.getBalance('0x...')
await client.bitcoin.getBalance('bc1...')
await client.solana.getBalance('HAgk...')

// Write (only when privateKey or mnemonic is provided)
const txHash = await client.ethereum.send({ to: '0x...', amount: '1000000000000000000' })

// Wait for confirmation
const confirmedTx = await client.ethereum.waitForTransaction(txHash)

// Clean up key material when done
client.ethereum.destroy()
```

## Unified API Reference

### ChainSigner (Offline -- all 30 chains)

Every chain signer implements these methods identically:

```typescript
import { EthereumSigner } from '@chainkit/ethereum'
import { BitcoinSigner } from '@chainkit/bitcoin'
import { SolanaSigner } from '@chainkit/solana'

// Works the same on ALL chains
const signer = new EthereumSigner()

// --- Mnemonic ---
const mnemonic = signer.generateMnemonic()        // 12 words (128 bits)
signer.generateMnemonic(256)                       // 24 words
signer.validateMnemonic(mnemonic)                  // true/false

// --- Key derivation ---
const pk = await signer.derivePrivateKey(mnemonic, "m/44'/60'/0'/0/0")

// --- Address ---
const address = signer.getAddress(pk)
signer.validateAddress(address)                    // true
signer.validateAddress('invalid')                  // false

// --- Default HD path ---
signer.getDefaultHdPath()                          // "m/44'/60'/0'/0/0"

// --- Sign transaction (unified params object) ---
const signed = await signer.signTransaction({
  privateKey: pk,
  tx: {
    to: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD68',
    value: '1000000000000000000',
    fee: { gasLimit: '0x5208', maxFeePerGas: '0x2540be400' },
    extra: { chainId: 1 },
  },
})

// --- Sign message ---
const sig = await signer.signMessage({
  privateKey: pk,
  message: 'Hello ChainKit',
})
```

#### ChainSigner Method Reference

| Method | Parameters | Return | Description |
|--------|-----------|--------|-------------|
| `generateMnemonic` | `strength?: number` (128 or 256) | `string` | Generate BIP39 mnemonic (12 or 24 words) |
| `validateMnemonic` | `mnemonic: string` | `boolean` | Validate a BIP39 mnemonic |
| `derivePrivateKey` | `mnemonic: string, hdPath: string` | `Promise<string> \| string` | Derive private key from mnemonic via BIP44 |
| `getAddress` | `privateKey: string` | `string` | Get address from private key |
| `validateAddress` | `address: string` | `boolean` | Validate address format for this chain |
| `signTransaction` | `params: { privateKey, tx }` | `Promise<string>` | Sign a transaction, returns signed tx hex |
| `signMessage` | `params: { privateKey, message }` | `Promise<string> \| string` | Sign an arbitrary message |
| `getDefaultHdPath` | (none) | `string` | Get the default HD derivation path |

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
const tx = await provider.getTransaction('0xabc...')
// { hash, from, to, value, fee, blockNumber, blockHash, status, timestamp, data, nonce }

// Block info
const block = await provider.getBlock(12345)
// { number, hash, parentHash, timestamp, transactions }

// Fee estimation (slow / average / fast)
const fee = await provider.estimateFee()
// { slow: '...', average: '...', fast: '...', unit: 'wei' }

// Broadcast signed transaction
const txHash = await provider.broadcastTransaction(signedTxHex)

// Chain info
const info = await provider.getChainInfo()
// { chainId: '1', name: 'Ethereum Mainnet', symbol: 'ETH', decimals: 18, testnet: false, blockHeight: 12345 }

// Wait for transaction confirmation
const confirmedTx = await provider.waitForTransaction('0xabc...', {
  timeoutMs: 60000,    // default: 60000 (1 minute)
  intervalMs: 3000,    // default: 3000 (3 seconds)
})
```

#### ChainProvider Method Reference

| Method | Parameters | Return | Description |
|--------|-----------|--------|-------------|
| `getBalance` | `address: string` | `Promise<Balance>` | Get native token balance |
| `getNativeBalances` | `address: string` | `Promise<Balance[]>` | Get all native balances (dual-token chains, optional) |
| `getTransaction` | `hash: string` | `Promise<TransactionInfo \| null>` | Get transaction by hash |
| `getBlock` | `hashOrNumber: string \| number` | `Promise<BlockInfo \| null>` | Get block by number or hash |
| `getNonce` | `address: string` | `Promise<string \| number>` | Get nonce/sequence number |
| `estimateFee` | (none) | `Promise<FeeEstimate>` | Estimate fees (slow/average/fast) |
| `broadcastTransaction` | `signedTx: string` | `Promise<string>` | Broadcast signed tx, returns tx hash |
| `getChainInfo` | (none) | `Promise<ChainInfo>` | Get chain metadata |
| `waitForTransaction` | `hash: string, options?: WaitForTransactionOptions` | `Promise<TransactionInfo>` | Poll until confirmed/failed/timeout |

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
// Ethereum, Kaia
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

## Unified Client

The unified client wraps signer and provider into a single ergonomic interface:

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
      network: 'mainnet',      // optional: 'mainnet' | 'testnet'
    },
    bitcoin: {
      chain: bitcoin,
      rpcs: ['https://...'],
      network: 'testnet',      // affects address format (bc1 vs tb1)
    },
  },
})

// --- Read (all chains) ---
await client.ethereum.getBalance('0x...')
await client.ethereum.getTransaction('0xabc...')
await client.ethereum.getBlock(12345)
await client.ethereum.estimateFee()
await client.ethereum.getChainInfo()

// --- Write (only when privateKey or mnemonic provided) ---

// send() auto-fetches nonce and fee, signs, and broadcasts
const txHash = await client.ethereum.send({
  to: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD68',
  amount: '1000000000000000000',
  memo: 'optional memo',
  data: '0x...',               // optional calldata
  options: { chainId: 1 },     // chain-specific overrides
})

// Wait for confirmation
const confirmed = await client.ethereum.waitForTransaction(txHash, {
  timeoutMs: 120000,
  intervalMs: 5000,
})

// prepareTransaction() builds an unsigned tx without signing
const unsignedTx = await client.ethereum.prepareTransaction({
  to: '0x...',
  amount: '1000000000000000000',
})

// Low-level signing (bypasses auto-fetch)
await client.ethereum.signTransaction({
  privateKey: '0x...',
  tx: { to: '0x...', value: '1000' },
})
await client.ethereum.signMessage({
  privateKey: '0x...',
  message: 'Hello',
})

// Get the address derived from the configured key
const myAddress = client.ethereum.getAddress()

// Access underlying signer/provider directly
client.ethereum.provider   // ChainProvider instance
client.ethereum.signer     // ChainSigner instance (only when key provided)

// Zero out stored private key material when done
client.ethereum.destroy()
```

### Client Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `chain` | `ChainDefinition` | (required) | Chain definition from `@chainkit/<chain>` |
| `rpcs` | `string[]` | (required) | RPC endpoint URLs |
| `network` | `'mainnet' \| 'testnet'` | `'mainnet'` | Controls address generation and default HD paths |
| `strategy` | `'failover' \| 'round-robin' \| 'fastest'` | `'failover'` | RPC endpoint selection strategy |
| `timeout` | `number` | `10000` | Request timeout in milliseconds |
| `retries` | `number` | `2` | Number of retries per endpoint |
| `privateKey` | `string` | (optional) | Private key for signing (hex string) |
| `mnemonic` | `string` | (optional) | BIP39 mnemonic for key derivation |
| `hdPath` | `string` | chain default | BIP44 HD derivation path |

**Security note:** When a signing client uses `strategy: 'fastest'`, the client automatically downgrades to `'failover'` to prevent a rogue endpoint from supplying manipulated nonce or fee data.

## ABI Encoder

ChainKit includes a built-in ABI encoder/decoder for EVM contract interactions. No external ABI libraries needed.

```typescript
import {
  encodeFunctionCall,
  encodeFunctionSelector,
  decodeFunctionResult,
  ERC20,
} from '@chainkit/core'

// --- Encode a function call ---
const transferData = encodeFunctionCall(
  'transfer(address,uint256)',
  ['0x742d35Cc6634C0532925a3b844Bc9e7595f2bD68', 1000000n],
)
// Returns: "0xa9059cbb000000000000000000000000742d35cc6634c0532925a3b844bc9e7595f2bd6800000000000000000000000000000000000000000000000000000000000f4240"

// --- ERC-20 presets ---
const approveData = encodeFunctionCall(ERC20.approve, ['0xSpender...', 1000000n])
const balanceData = encodeFunctionCall(ERC20.balanceOf, ['0xHolder...'])
// Available presets: ERC20.transfer, ERC20.approve, ERC20.balanceOf,
// ERC20.allowance, ERC20.totalSupply, ERC20.decimals, ERC20.symbol, ERC20.name

// --- Get function selector ---
const selector = encodeFunctionSelector('transfer(address,uint256)')
// "0xa9059cbb"

// --- Decode return data ---
const [balance] = decodeFunctionResult(['uint256'], '0x00000000000000000000000000000000000000000000000000000000000f4240')
// balance = 1000000n

// Decode multiple return values
const [addr, amount] = decodeFunctionResult(
  ['address', 'uint256'],
  returnDataHex,
)
```

### Supported ABI Types

| Type | Encode | Decode |
|------|--------|--------|
| `address` | `encodeAddress` | `decodeAddress` |
| `uint256` (and all uint*) | `encodeUint256` | `decodeUint256` |
| `int256` (and all int*) | `encodeInt256` | `decodeInt256` |
| `bool` | `encodeBool` | `decodeBool` |
| `bytes32` (and all fixed bytes*) | `encodeBytes32` | `decodeBytes32` |
| `string` | `encodeString` | `decodeString` |
| `bytes` | `encodeBytes` | (via `decodeFunctionResult`) |

**Limitation:** Dynamic arrays (e.g., `uint256[]`) are not supported in the encoder. For complex ABI encoding with arrays, use an external ABI library.

## SecureKey

JavaScript strings are immutable and cannot be cleared from memory. SecureKey stores private key material as a mutable `Uint8Array` that can be explicitly zeroed.

```typescript
import { SecureKey } from '@chainkit/core'

// Create from hex string or Uint8Array
const key = new SecureKey('0xabc123...')

// Access key material
key.hex     // "0xabc123..." (0x-prefixed hex string)
key.bytes   // Uint8Array

// Check if destroyed
key.isDestroyed  // false

// Zero out key material
key.destroy()

// After destroy, accessing .hex or .bytes throws an error
key.isDestroyed  // true
key.hex           // throws Error: 'SecureKey has been destroyed'
```

The unified client uses SecureKey internally. Call `client.<chain>.destroy()` to zero the stored key material when the client is no longer needed.

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

### strictHttps

Enable `strictHttps: true` to reject non-HTTPS endpoints (except localhost/127.0.0.1). Without this flag, insecure endpoints produce a console warning but are still used.

```typescript
const provider = new EthereumProvider({
  endpoints: ['https://eth-mainnet.example.com'],
  strictHttps: true,  // throws on http:// endpoints
})
```

### RPC URL Redaction

Error messages from RPC failures automatically redact endpoint URLs to prevent API key leakage. For example, `https://eth-mainnet.g.alchemy.com/v2/sk_abc123` becomes `https://eth-mainnet.g.alchemy.com/...`.

### JSON-RPC Response Validation

The RPC manager validates that:
- Responses conform to JSON-RPC 2.0 structure
- Response IDs match request IDs (prevents response desynchronization from a malicious endpoint)

## Key Management

- **BIP39 mnemonic**: 12 or 24 word phrases (128/256 bit entropy)
- **BIP32/44 HD derivation**: Standard derivation paths per chain (e.g., `m/44'/60'/0'/0/0` for Ethereum)
- **Raw private key**: Direct hex-encoded private key input
- **WIF**: Bitcoin Wallet Import Format
- **Address validation**: Per-chain format validation (EIP-55 checksum, bech32, base58, base58check, SS58, etc.)

## Network Configuration

The `network` option on `createClient` controls address generation and default HD paths. This matters for chains where mainnet and testnet use different address formats or coin types.

```typescript
// Bitcoin: network affects address prefix (bc1 vs tb1) and HD path coin type
const client = await createClient({
  chains: {
    bitcoin: {
      chain: bitcoin,
      rpcs: ['https://...'],
      network: 'testnet',  // generates tb1... addresses, uses m/84'/1'/0'/0/0
      mnemonic: '...',
    },
  },
})

// Stacks: network affects address prefix (SP vs ST) and tx chain ID
const client = await createClient({
  chains: {
    stacks: {
      chain: stacks,
      rpcs: ['https://api.testnet.hiro.so'],
      network: 'testnet',  // generates ST... addresses
      mnemonic: '...',
    },
  },
})
```

Chains where `network` affects behavior:
- **Bitcoin**: Address prefix (`bc1` vs `tb1`), HD path coin type (`0'` vs `1'`), address validation
- **Stacks**: Address prefix (`SP` vs `ST`), transaction chain ID

For all other chains, `network` is accepted but does not change address derivation.

## Default HD Paths

| Chain | Default HD Path | Coin Type |
|-------|----------------|-----------|
| Ethereum | `m/44'/60'/0'/0/0` | 60 |
| Bitcoin (mainnet) | `m/84'/0'/0'/0/0` | 0 |
| Bitcoin (testnet) | `m/84'/1'/0'/0/0` | 1 |
| Solana | `m/44'/501'/0'/0'` | 501 |
| Tron | `m/44'/195'/0'/0/0` | 195 |
| TON | `m/44'/607'/0'/0'/0'` | 607 |
| Cosmos | `m/44'/118'/0'/0/0` | 118 |
| Aptos | `m/44'/637'/0'/0'/0'` | 637 |
| Sui | `m/44'/784'/0'/0'/0'` | 784 |
| NEAR | `m/44'/397'/0'` | 397 |
| Cardano | `m/1852'/1815'/0'/0/0` | 1815 |
| XRP | `m/44'/144'/0'/0/0` | 144 |
| Stellar | `m/44'/148'/0'` | 148 |
| StarkNet | `m/44'/9004'/0'/0/0` | 9004 |
| Stacks | `m/44'/5757'/0'/0/0` | 5757 |
| Kaia | `m/44'/8217'/0'/0/0` | 8217 |
| EOS | `m/44'/194'/0'/0/0` | 194 |
| Polkadot | `m/44'/354'/0'/0/0` | 354 |
| Hedera | `m/44'/3030'/0'/0/0` | 3030 |
| Filecoin | `m/44'/461'/0'/0/0` | 461 |
| ICP | `m/44'/223'/0'/0/0` | 223 |
| Algorand | `m/44'/283'/0'/0/0` | 283 |
| VeChain | `m/44'/818'/0'/0/0` | 818 |
| Tezos | `m/44'/1729'/0'/0'` | 1729 |
| Theta | `m/44'/500'/0'/0/0` | 500 |
| MultiversX | `m/44'/508'/0'/0'/0'` | 508 |
| IOTA | `m/44'/4218'/0'/0'/0'` | 4218 |
| Neo | `m/44'/888'/0'/0/0` | 888 |
| Flow | `m/44'/539'/0'/0/0` | 539 |
| Icon | `m/44'/4801074'/0'/0/0` | 4801074 |
| Mina | `m/44'/12586'/0'/0/0` | 12586 |

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
| `@chainkit/core` | Shared interfaces, types, crypto utilities (BIP39/32), RPC manager, ABI encoder/decoder, SecureKey |
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
| `@chainkit/hedera` | Hedera (ED25519 + ECDSA signers) |
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

Hedera provides two signers:
- `HederaSigner` (default, ED25519) -- Hedera-native transactions with public key alias addresses
- `HederaEcdsaSigner` (Secp256k1) -- EVM-compatible mode with 0x addresses, for use with Hedera's EVM relay

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

## Security

Full audit report: [`docs/security-audit-report-2026-04.md`](docs/security-audit-report-2026-04.md)

Key security properties:

- **No third-party chain SDKs** -- eliminates supply chain attack surface
- **All crypto via Cure53-audited libraries** -- `@noble/hashes`, `@noble/secp256k1`, `@noble/ed25519`, `@scure/bip39`, `@scure/base`
- **Private key zeroing** -- SecureKey stores keys as Uint8Array, explicitly zeroed via `destroy()`
- **Address validation before signing** -- recipient addresses validated against chain format before transaction construction
- **ChainId enforcement for EVM** -- `extra.chainId` required, preventing cross-chain replay attacks
- **strictHttps option** -- reject non-HTTPS RPC endpoints in production
- **Nonce mutex** -- concurrent `send()` calls use a serialized nonce counter to prevent nonce collisions
- **RPC response validation** -- JSON-RPC 2.0 structure verification and request/response ID matching
- **URL redaction** -- API keys in RPC URLs are never exposed in error messages
- **Bitcoin fee sanity check** -- fee cannot exceed 50% of total input value
- **Network enforcement** -- Bitcoin signer rejects addresses from wrong network (mainnet/testnet)
- **Mnemonic validation** -- invalid mnemonics rejected before seed derivation
- **Strategy auto-downgrade** -- signing clients using `fastest` strategy automatically downgrade to `failover`
- **Input sanitization** -- `send()` strips signing-critical fields (`outputs`, `inputs`) from user-provided options

Audit summary: 24 findings (18 initial + 6 cross-check), 22 remediated, 2 accepted as known risks with documented justification. See audit report for details.

## Testnet Verification

24/30 chains have been verified with real testnet transactions. 30/30 chains have verified address derivation.

| Chain | Testnet | Address | Balance | Tx Send |
|-------|---------|---------|---------|---------|
| Ethereum | Sepolia | PASS | PASS | PASS |
| Bitcoin | Testnet | PASS | PASS | PASS |
| Solana | Devnet | PASS | PASS | PASS |
| Tron | Shasta | PASS | PASS | PASS |
| TON | Testnet | PASS | PASS | PASS |
| Cosmos | Theta Testnet | PASS | PASS | PASS |
| Aptos | Devnet | PASS | PASS | PASS |
| Sui | Devnet | PASS | PASS | PASS |
| NEAR | Testnet | PASS | PASS | PASS |
| XRP | Testnet | PASS | PASS | PASS |
| Stellar | Testnet | PASS | PASS | PASS |
| Stacks | Testnet | PASS | PASS | PASS |
| Kaia | Kairos | PASS | PASS | PASS |
| EOS | Jungle4 | PASS | PASS | PASS |
| Cardano | Preview | PASS | PASS | PASS |
| StarkNet | Sepolia | PASS | PASS | PASS |
| Hedera | Testnet | PASS | PASS | PASS |
| Filecoin | Calibration | PASS | PASS | PASS |
| ICP | Mainnet Rosetta | PASS | PASS | PASS |
| Algorand | Testnet | PASS | PASS | PASS |
| VeChain | Testnet | PASS | PASS | PASS |
| Tezos | Ghostnet | PASS | PASS | PASS |
| Theta | Testnet | PASS | PASS | PASS |
| MultiversX | Testnet | PASS | PASS | PASS |
| Polkadot | Westend | PASS | PASS | N/A |
| Mina | Devnet | PASS | PASS | N/A |
| Neo | N/A | PASS | N/A | N/A |
| Flow | N/A | PASS | N/A | N/A |
| Icon | N/A | PASS | N/A | N/A |
| IOTA | N/A | PASS | N/A | N/A |

**Not yet verified on testnet (4 chains):** Neo, Flow, Icon, IOTA -- no accessible public testnet RPC at time of audit. Address derivation is verified for all 4.

**Polkadot and Mina:** Balance queries verified, but transaction send requires native token deposits not available via faucet at time of testing.

No mainnet verification has been performed.

## Playground

ChainKit includes a browser-based wallet playground for testing all 30 chains interactively. It provides:

- Per-chain wallet generation from mnemonic
- Address derivation across all signature algorithms
- Global wallet: derive addresses for all 30 chains from a single mnemonic
- Balance queries against testnets

```bash
cd playground
npm install
npm run dev
```

## Architecture

```
@chainkit/client (unified multi-chain client)
  |
  +-- createClient() --> ReadOnlyChainInstance (no key = read-only)
  |                  --> FullChainInstance     (key provided = read+write)
  |                      +-- send()              auto nonce+fee, sign, broadcast
  |                      +-- prepareTransaction() build unsigned tx
  |                      +-- waitForTransaction() poll until confirmed
  |                      +-- destroy()            zero key material
  |
  +-- @chainkit/core
  |     +-- ChainSigner interface    (generateMnemonic, derivePrivateKey, getAddress,
  |     |                             signTransaction, signMessage, validateAddress,
  |     |                             getDefaultHdPath)
  |     +-- ChainProvider interface  (getBalance, getTransaction, getBlock, getNonce,
  |     |                             estimateFee, broadcastTransaction, getChainInfo,
  |     |                             waitForTransaction)
  |     +-- Capabilities             (ContractCapable, TokenCapable, UtxoCapable,
  |     |                             SubscriptionCapable, EvmSignerCapable)
  |     +-- RpcManager               (failover, round-robin, fastest, strictHttps)
  |     +-- ABI Encoder/Decoder      (encodeFunctionCall, decodeFunctionResult, ERC20 presets)
  |     +-- SecureKey                (Uint8Array key storage with explicit zeroing)
  |     +-- Crypto utilities         (BIP39 mnemonic, BIP32 HD derivation via @scure/bip39
  |                                   + @noble/hashes)
  |
  +-- @chainkit/<chain>
        +-- signer.ts    (offline: key generation, address derivation, tx signing,
        |                 message signing)
        +-- provider.ts  (online: RPC queries, balance, blocks, broadcasting,
        |                 token ops)
        +-- types.ts     (chain-specific types)
```

## License

MIT
