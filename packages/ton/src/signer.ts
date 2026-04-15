import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { Cell, beginCell } from './boc.js'

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
 * Decode base64 (standard or url-safe) to Uint8Array.
 */
function fromBase64(str: string): Uint8Array {
  // Normalize base64url to standard base64
  const std = str.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(std)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
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

/**
 * Parse a user-friendly TON address (base64/base64url) to raw workchain:hash format.
 */
function parseUserFriendlyAddress(address: string): { workchain: number; hash: Uint8Array } {
  const data = fromBase64(address)
  if (data.length !== 36) {
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, `Invalid user-friendly address length: ${data.length}`)
  }

  // Verify CRC16
  const payload = data.subarray(0, 34)
  const checksum = data.subarray(34, 36)
  const computed = crc16(payload)
  if (computed[0] !== checksum[0] || computed[1] !== checksum[1]) {
    throw new ChainKitError(ErrorCode.INVALID_ADDRESS, 'Invalid user-friendly address checksum')
  }

  const workchain = data[1] > 127 ? data[1] - 256 : data[1] // signed byte
  const hash = data.subarray(2, 34)

  return { workchain, hash: new Uint8Array(hash) }
}

/**
 * Parse any TON address format (raw or user-friendly) to workchain + hash.
 */
function parseAddress(address: string): { workchain: number; hash: Uint8Array } {
  // Raw format: "0:hexhash" or "-1:hexhash"
  if (address.includes(':')) {
    const parts = address.split(':')
    const workchain = parseInt(parts[0], 10)
    const hash = hexToBytes(parts[1].padStart(64, '0'))
    return { workchain, hash }
  }

  // User-friendly format (base64/base64url)
  return parseUserFriendlyAddress(address)
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

/** Cached wallet v4r2 code cell (parsed once) */
let _walletCodeCell: Cell | null = null

/**
 * Get the wallet v4r2 code cell.
 */
function getWalletV4R2Code(): Cell {
  if (!_walletCodeCell) {
    _walletCodeCell = Cell.fromBoc(fromBase64(WALLET_V4R2_CODE_BASE64))[0]
  }
  return _walletCodeCell
}

/**
 * Build the wallet v4r2 initial data cell.
 * Layout: seqno(32) + subwallet_id(32) + public_key(256) + plugins_dict(empty)
 */
function buildWalletData(publicKey: Uint8Array, subwalletId: number = DEFAULT_SUBWALLET_ID): Cell {
  return beginCell()
    .storeUint(0, 32) // seqno = 0
    .storeUint(subwalletId, 32)
    .storeBytes(publicKey) // 256 bits = 32 bytes
    .storeBit(0) // empty plugins dictionary
    .endCell()
}

/**
 * Build the wallet v4r2 StateInit cell.
 * TL-B: _ split_depth:(Maybe (## 5)) special:(Maybe TickTock) code:(Maybe ^Cell) data:(Maybe ^Cell) library:(HashmapE 256 SimpleLib)
 */
function buildStateInitCell(code: Cell, data: Cell): Cell {
  return beginCell()
    .storeBit(0) // split_depth: nothing
    .storeBit(0) // special: nothing
    .storeBit(1) // code: present
    .storeBit(1) // data: present
    .storeBit(0) // library: nothing
    .storeRef(code)
    .storeRef(data)
    .endCell()
}

/**
 * Get the wallet v4r2 contract address for a given public key.
 * Address = workchain:SHA256(stateInit_cell_representation)
 */
function getWalletAddress(publicKey: Uint8Array, workchain = 0): { workchain: number; hash: Uint8Array; raw: string } {
  const code = getWalletV4R2Code()
  const data = buildWalletData(publicKey)
  const stateInitCell = buildStateInitCell(code, data)
  const hash = stateInitCell.hash()
  return {
    workchain,
    hash,
    raw: `${workchain}:${bytesToHex(hash)}`,
  }
}

/**
 * Build an internal message cell for a simple TON transfer.
 *
 * TL-B: int_msg_info$0 ihr_disabled:Bool bounce:Bool bounced:Bool
 *       src:MsgAddressInt dest:MsgAddressInt value:CurrencyCollection
 *       ihr_fee:Grams fwd_fee:Grams created_lt:uint64 created_at:uint32
 *       init:(Maybe (Either StateInit ^StateInit))
 *       body:(Either X ^X)
 */
function buildInternalMessage(params: {
  dest: { workchain: number; hash: Uint8Array }
  value: bigint
  bounce: boolean
  body?: Cell
}): Cell {
  const { dest, value, bounce, body } = params

  const builder = beginCell()
  // int_msg_info$0
  builder.storeBit(0)
  // ihr_disabled = true
  builder.storeBit(1)
  // bounce
  builder.storeBit(bounce)
  // bounced = false
  builder.storeBit(0)
  // src: addr_none$00
  builder.storeAddress(null)
  // dest: addr_std$10
  builder.storeAddress(dest)
  // value: Grams (coins)
  builder.storeCoins(value)
  // extra currencies: empty (0 bit)
  builder.storeBit(0)
  // ihr_fee: 0
  builder.storeCoins(0n)
  // fwd_fee: 0
  builder.storeCoins(0n)
  // created_lt: 0
  builder.storeUint(0, 64)
  // created_at: 0
  builder.storeUint(0, 32)
  // init: nothing (0)
  builder.storeBit(0)
  // body: either inline or reference
  if (body) {
    builder.storeBit(1) // body as reference
    builder.storeRef(body)
  } else {
    builder.storeBit(0) // no body (empty inline)
  }

  return builder.endCell()
}

/**
 * Build the wallet v4r2 transfer body (unsigned).
 *
 * Layout:
 *   subwallet_id(32) + valid_until(32) + seqno(32) + op(8) + [mode(8) + ref(msg)]...
 */
function buildTransferBody(params: {
  seqno: number
  internalMsgCell: Cell
  subwalletId?: number
  validUntil?: number
}): Cell {
  const {
    seqno,
    internalMsgCell,
    subwalletId = DEFAULT_SUBWALLET_ID,
    validUntil = Math.floor(Date.now() / 1000) + 60,
  } = params

  const builder = beginCell()
    .storeUint(subwalletId, 32)
    .storeUint(validUntil, 32)
    .storeUint(seqno, 32)
    .storeUint(0, 8) // op = 0 (simple send)

  // Message: mode(8) + ref(internal_msg)
  builder
    .storeUint(3, 8) // send mode: pay fees separately + ignore errors
    .storeRef(internalMsgCell)

  return builder.endCell()
}

/**
 * Build the external message cell wrapping a signed wallet transfer.
 *
 * TL-B: ext_in_msg_info$10 src:MsgAddressExt dest:MsgAddressInt import_fee:Grams
 *       init:(Maybe (Either StateInit ^StateInit))
 *       body:(Either X ^X)
 */
function buildExternalMessage(params: {
  walletAddress: { workchain: number; hash: Uint8Array }
  signedBody: Cell
  stateInitCell?: Cell
}): Cell {
  const { walletAddress, signedBody, stateInitCell } = params

  const builder = beginCell()
  // ext_in_msg_info$10
  builder.storeUint(2, 2)
  // src: addr_none$00
  builder.storeUint(0, 2)
  // dest: addr_std$10
  builder.storeAddress(walletAddress)
  // import_fee: 0
  builder.storeCoins(0n)

  if (stateInitCell) {
    // init: just (left stateInit) - inline state init
    builder.storeBit(1) // has init
    builder.storeBit(0) // inline (not reference)
    // Write the stateInit cell data + refs inline
    builder.storeCell(stateInitCell)
  } else {
    builder.storeBit(0) // no init
  }

  // body: inline (the signed body fits within the remaining space)
  builder.storeBit(0) // body inline
  builder.storeCell(signedBody)

  return builder.endCell()
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

    // Compute wallet v4r2 contract address
    const wallet = getWalletAddress(publicKey)

    return wallet.raw
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
   * Returns base64-encoded BOC string.
   *
   * tx.nonce is used as the seqno. If not provided, defaults to 0.
   * tx.extra.bounce defaults to true.
   * tx.extra.validUntil can override the message validity window.
   * tx.extra.stateInit can be set to true to include StateInit (for first transaction from wallet).
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get public key and wallet address
    const publicKey = ed25519.getPublicKey(pkBytes)
    const walletAddr = getWalletAddress(publicKey)

    // Parse transaction parameters
    const bounce = tx.extra?.bounce !== undefined ? (tx.extra.bounce as boolean) : true
    const seqno = tx.nonce ?? 0
    const validUntil = tx.extra?.validUntil
      ? (tx.extra.validUntil as number)
      : Math.floor(Date.now() / 1000) + 60
    const includeStateInit = tx.extra?.stateInit === true || seqno === 0

    // Parse destination address
    let destAddr: { workchain: number; hash: Uint8Array }
    try {
      destAddr = parseAddress(tx.to)
    } catch {
      throw new ChainKitError(
        ErrorCode.INVALID_ADDRESS,
        `Invalid destination address: ${tx.to}`,
      )
    }

    // Build the internal transfer message
    const internalMsgCell = buildInternalMessage({
      dest: destAddr,
      value: BigInt(tx.value as string),
      bounce,
    })

    // Build the wallet v4r2 transfer body
    const transferBody = buildTransferBody({
      seqno,
      internalMsgCell,
      validUntil,
    })

    // Hash the body cell and sign with ED25519
    const bodyHash = transferBody.hash()
    const signature = ed25519.sign(bodyHash, pkBytes)

    // Build signed body: signature(512 bits) + original body data + refs
    const signedBody = beginCell()
      .storeBytes(signature) // 64 bytes = 512 bits
      .storeCell(transferBody) // inline: copy bits + refs from transfer body
      .endCell()

    // Build state init cell if needed
    let stateInitCell: Cell | undefined
    if (includeStateInit) {
      const code = getWalletV4R2Code()
      const data = buildWalletData(publicKey)
      stateInitCell = buildStateInitCell(code, data)
    }

    // Build external message
    const extCell = buildExternalMessage({
      walletAddress: walletAddr,
      signedBody,
      stateInitCell,
    })

    // Serialize to BOC
    const boc = extCell.toBoc()

    // Return as base64 (this is what TON APIs expect for sendBoc)
    let binary = ''
    for (const byte of boc) {
      binary += String.fromCharCode(byte)
    }
    return btoa(binary)
  }

  /**
   * Validate a TON address.
   * Supports raw format (workchain:hash, 64 hex chars) and user-friendly (base64url with CRC16).
   */
  validateAddress(address: string): boolean {
    try {
      if (address.includes(':')) {
        // Raw format: workchain:hexhash
        const parts = address.split(':')
        if (parts.length !== 2) return false
        const workchain = parseInt(parts[0], 10)
        if (isNaN(workchain)) return false
        if (!/^[0-9a-fA-F]{64}$/.test(parts[1])) return false
        return true
      }
      // User-friendly format: base64/base64url, 36 bytes decoded
      parseUserFriendlyAddress(address)
      return true
    } catch {
      return false
    }
  }

  /**
   * Sign an arbitrary message with ED25519.
   * Returns the 64-byte ED25519 signature as a hex string.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
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
