import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx } from '@chainkit/core'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import {
  Address as TonAddress,
  beginCell,
  Cell,
  contractAddress as computeContractAddress,
  internal,
  external,
  storeMessage,
  storeMessageRelaxed,
  toNano,
} from '@ton/core'
import type { StateInit, MessageRelaxed } from '@ton/core'

// ed25519 requires sha512 to be set
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  return sha512(ed25519.etc.concatBytes(...m))
}

/**
 * Strip the '0x' prefix from a hex string if present.
 */
function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex
}

/**
 * Add the '0x' prefix to a hex string if not already present.
 */
function addHexPrefix(hex: string): string {
  return hex.startsWith('0x') ? hex : `0x${hex}`
}

/**
 * Compute CRC16-CCITT for TON user-friendly address encoding.
 */
function crc16(data: Uint8Array): Uint8Array {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff
      } else {
        crc = (crc << 1) & 0xffff
      }
    }
  }
  return new Uint8Array([crc >> 8, crc & 0xff])
}

/**
 * Encode bytes to base64url (no padding).
 */
function toBase64url(data: Uint8Array): string {
  let binary = ''
  for (const byte of data) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_')
}

/**
 * Convert a raw address (workchain:hash) to user-friendly base64url format.
 * Format: [flags(1)][workchain(1)][hash(32)][crc16(2)] = 36 bytes, base64url encoded
 */
function rawToUserFriendly(rawAddress: string, bounceable = true): string {
  const parts = rawAddress.split(':')
  if (parts.length !== 2) {
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Invalid raw address format: ${rawAddress}`)
  }

  const workchain = parseInt(parts[0], 10)
  const hashHex = parts[1]
  const hashBytes = hexToBytes(hashHex.padStart(64, '0'))

  // flags: 0x11 = bounceable, 0x51 = non-bounceable
  const flags = bounceable ? 0x11 : 0x51

  // Build the 34-byte payload
  const payload = new Uint8Array(34)
  payload[0] = flags
  payload[1] = workchain & 0xff
  payload.set(hashBytes, 2)

  // Compute CRC16
  const checksum = crc16(payload)

  // Concatenate payload + checksum
  const result = new Uint8Array(36)
  result.set(payload, 0)
  result.set(checksum, 34)

  return toBase64url(result)
}

// ---- Wallet V4R2 Constants ----

/**
 * Standard Wallet V4R2 contract code BOC (base64).
 * This is the universally used wallet contract on TON.
 * Source: https://github.com/ton-blockchain/wallet-contract-v4
 * Code hash: feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0
 */
const WALLET_V4R2_CODE_BASE64 =
  'te6cckECFAEAAtQAART/APSkE/S88sgLAQIBIAIPAgFIAwYC5tAB0NMDIXGwkl8E4CLXScEgkl8E4ALTHyGCEHBsdWe9IoIQZHN0cr2wkl8F4AP6QDAg+kQByMoHy//J0O1E0IEBQNch9AQwXIEBCPQKb6Exs5JfB+AF0z/IJYIQcGx1Z7qSODDjDQOCEGRzdHK6kl8G4w0EBQB4AfoA9AQw+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAGAIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6AhPLassfyz/JgED7AJJfA+ICASAHDgIBIAgNAgFYCQoAPbKd+1E0IEBQNch9AQwAsjKB8v/ydABgQEI9ApvoTGACASALDAAZrc52omhAIGuQ64X/wAAZrx32omhAEGuQ64WPwAARuMl+1E0NcLH4AFm9JCtvaiaECAoGuQ+gIYRw1AgIR6STfSmRDOaQPp/5g3gSgBt4EBSJhxWfMYQE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8QERITAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQBfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVAj45Sg='

/**
 * Default sub-wallet ID for wallet v4r2.
 */
const DEFAULT_SUBWALLET_ID = 698983191

/**
 * Get the wallet v4r2 code cell.
 */
function getWalletV4R2Code(): Cell {
  return Cell.fromBoc(Buffer.from(WALLET_V4R2_CODE_BASE64, 'base64'))[0]
}

/**
 * Build the wallet v4r2 initial data cell.
 * Layout: seqno(32) + subwallet_id(32) + public_key(256) + plugins_dict(empty)
 */
function buildWalletData(publicKey: Buffer, subwalletId: number = DEFAULT_SUBWALLET_ID): Cell {
  return beginCell()
    .storeUint(0, 32) // seqno = 0
    .storeUint(subwalletId, 32)
    .storeBuffer(publicKey) // 256 bits = 32 bytes
    .storeBit(0) // empty plugins dictionary
    .endCell()
}

/**
 * Get the wallet v4r2 StateInit for a given public key.
 */
function getWalletStateInit(publicKey: Buffer): StateInit {
  const code = getWalletV4R2Code()
  const data = buildWalletData(publicKey)
  return { code, data }
}

/**
 * Get the wallet v4r2 contract address for a given public key.
 */
function getWalletAddress(publicKey: Buffer, workchain = 0): TonAddress {
  const stateInit = getWalletStateInit(publicKey)
  return computeContractAddress(workchain, stateInit)
}

/**
 * Build the wallet v4r2 transfer body (unsigned).
 *
 * Layout:
 *   subwallet_id(32) + valid_until(32) + seqno(32) + op(8) + [messages...]
 *
 * For simple transfer, op = 0.
 * Each message: mode(8) + ref(MessageRelaxed)
 */
function buildTransferBody(params: {
  seqno: number
  messages: MessageRelaxed[]
  subwalletId?: number
  validUntil?: number
}): Cell {
  const {
    seqno,
    messages,
    subwalletId = DEFAULT_SUBWALLET_ID,
    validUntil = Math.floor(Date.now() / 1000) + 60, // 60 seconds validity
  } = params

  const builder = beginCell()
    .storeUint(subwalletId, 32)
    .storeUint(validUntil, 32)
    .storeUint(seqno, 32)
    .storeUint(0, 8) // op = 0 (simple send)

  for (const msg of messages) {
    builder
      .storeUint(3, 8) // send mode: pay fees separately + ignore errors
      .storeRef(beginCell().store(storeMessageRelaxed(msg)).endCell())
  }

  return builder.endCell()
}

/**
 * Sign a wallet v4r2 transfer body and wrap in an external message.
 * Returns the BOC as a Buffer.
 */
function signAndWrapTransfer(params: {
  body: Cell
  privateKey: Uint8Array
  walletAddress: TonAddress
  stateInit?: StateInit
}): Buffer {
  const { body, privateKey, walletAddress, stateInit } = params

  // Hash the body cell
  const bodyHash = body.hash()

  // Sign with ED25519
  const signature = ed25519.sign(new Uint8Array(bodyHash), privateKey)

  // Build signed body: signature(512 bits) + original body
  const signedBody = beginCell()
    .storeBuffer(Buffer.from(signature)) // 64 bytes = 512 bits
    .storeSlice(body.beginParse())
    .endCell()

  // Wrap in external message
  const ext = external({
    to: walletAddress,
    init: stateInit,
    body: signedBody,
  })

  // Serialize to BOC
  const cell = beginCell().store(storeMessage(ext)).endCell()
  return cell.toBoc()
}

/**
 * TON signer implementing the ChainSigner interface.
 * Uses ED25519 for key derivation and signing.
 * Produces real BOC (Bag of Cells) for transaction signing via wallet v4r2 contract.
 * Default HD path: m/44'/607'/0'
 */
export class TonSigner implements ChainSigner {
  /**
   * Generate a new BIP39 mnemonic phrase.
   */
  generateMnemonic(strength?: number): string {
    return generateMnemonic(strength)
  }

  /**
   * Validate a BIP39 mnemonic phrase.
   */
  validateMnemonic(mnemonic: string): boolean {
    return validateMnemonic(mnemonic)
  }

  /**
   * Derive a private key from a mnemonic using a BIP44 HD path.
   * TON default path: m/44'/607'/0'
   * Returns a '0x'-prefixed hex string (32-byte ED25519 seed).
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return addHexPrefix(privateKeyHex)
  }

  /**
   * Get the TON wallet v4r2 contract address for a given private key.
   * Returns the raw address in workchain:hash format (e.g., "0:abc...").
   *
   * The address is computed by:
   * 1. Derive ED25519 public key from private key
   * 2. Build wallet v4r2 StateInit (code + data with public key)
   * 3. Compute contract address = hash(stateInit)
   */
  getAddress(privateKey: HexString): Address {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get ED25519 public key (32 bytes)
    const publicKey = ed25519.getPublicKey(pkBytes)
    const pubKeyBuffer = Buffer.from(publicKey)

    // Compute wallet v4r2 contract address
    const walletAddress = getWalletAddress(pubKeyBuffer)

    return walletAddress.toRawString()
  }

  /**
   * Get the user-friendly base64url address for a given private key.
   */
  getUserFriendlyAddress(privateKey: HexString, bounceable = true): string {
    const rawAddress = this.getAddress(privateKey)
    return rawToUserFriendly(rawAddress, bounceable)
  }

  /**
   * Sign a TON transaction producing a valid BOC (Bag of Cells) external message.
   *
   * Uses the wallet v4r2 contract standard:
   * - Builds an internal transfer message (to, amount, bounce)
   * - Wraps it in a wallet v4r2 body (subwallet_id, valid_until, seqno, op, messages)
   * - Signs the body hash with ED25519
   * - Wraps in an external message targeting the wallet contract
   * - Serializes as BOC
   *
   * Returns base64-encoded BOC string (prefixed with "0x" per ChainKit convention,
   * but the actual content is base64, not hex).
   *
   * tx.nonce is used as the seqno. If not provided, defaults to 0.
   * tx.extra.bounce defaults to true.
   * tx.extra.validUntil can override the message validity window.
   * tx.extra.stateInit can be set to true to include StateInit (for first transaction from wallet).
   */
  async signTransaction(tx: UnsignedTx, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get public key and wallet address
    const publicKey = ed25519.getPublicKey(pkBytes)
    const pubKeyBuffer = Buffer.from(publicKey)
    const walletAddress = getWalletAddress(pubKeyBuffer)
    const walletStateInit = getWalletStateInit(pubKeyBuffer)

    // Parse transaction parameters
    const bounce = tx.extra?.bounce !== undefined ? (tx.extra.bounce as boolean) : true
    const seqno = tx.nonce ?? 0
    const validUntil = tx.extra?.validUntil
      ? (tx.extra.validUntil as number)
      : Math.floor(Date.now() / 1000) + 60
    const includeStateInit = tx.extra?.stateInit === true || seqno === 0

    // Parse destination address
    let toAddress: TonAddress
    try {
      if (tx.to.includes(':')) {
        toAddress = TonAddress.parseRaw(tx.to)
      } else {
        toAddress = TonAddress.parse(tx.to)
      }
    } catch {
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        `Invalid destination address: ${tx.to}`,
      )
    }

    // Build the internal transfer message
    const internalMsg = internal({
      to: toAddress,
      value: BigInt(tx.value),
      bounce,
      body: tx.data ? tx.data : undefined,
    })

    // Build the wallet v4r2 transfer body
    const transferBody = buildTransferBody({
      seqno,
      messages: [internalMsg],
      validUntil,
    })

    // Sign and wrap in external message
    const bocBuffer = signAndWrapTransfer({
      body: transferBody,
      privateKey: pkBytes,
      walletAddress,
      stateInit: includeStateInit ? walletStateInit : undefined,
    })

    // Return as base64 (this is what TON APIs expect for sendBoc)
    return bocBuffer.toString('base64')
  }

  /**
   * Sign an arbitrary message with ED25519.
   * Returns the 64-byte ED25519 signature as a hex string.
   */
  async signMessage(message: string | Uint8Array, privateKey: HexString): Promise<HexString> {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Convert message to bytes
    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message

    // Hash and sign with ED25519
    const msgHash = sha256(msgBytes)
    const signature = ed25519.sign(msgHash, pkBytes)

    return addHexPrefix(bytesToHex(signature))
  }

  /**
   * Verify an ED25519 signature.
   */
  verifySignature(
    message: string | Uint8Array,
    signature: HexString,
    publicKey: HexString,
  ): boolean {
    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message
    const msgHash = sha256(msgBytes)
    const sigBytes = hexToBytes(stripHexPrefix(signature))
    const pubBytes = hexToBytes(stripHexPrefix(publicKey))

    return ed25519.verify(sigBytes, msgHash, pubBytes)
  }

  /**
   * Get the public key for a given private key.
   */
  getPublicKey(privateKey: HexString): HexString {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    const publicKey = ed25519.getPublicKey(pkBytes)
    return addHexPrefix(bytesToHex(publicKey))
  }
}

export { rawToUserFriendly }
