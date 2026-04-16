import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams } from '@chainkit/core'
import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import { sha3_256 } from '@noble/hashes/sha3'
import { sha512 } from '@noble/hashes/sha512'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

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
 * BIP44 path regex: m / purpose' / coin_type' / account' / change / address_index
 */
const BIP44_PATH_REGEX = /^m(\/\d+'?)+$/

/**
 * HMAC-based key derivation for P-256 from a BIP39 seed.
 *
 * Since @scure/bip32 HDKey is secp256k1-only, we implement a simplified
 * HMAC-based derivation similar to SLIP-0010 but for the P-256 curve.
 *
 * Master key derivation uses "Nist256p1 seed" as the HMAC key per SLIP-0010.
 */
function p256MasterKey(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode('Nist256p1 seed'), seed)
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32),
  }
}

/**
 * SLIP-0010 P-256 child key derivation (hardened only for safety).
 */
function p256DeriveChild(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  const isHardened = index >= 0x80000000

  let data: Uint8Array
  if (isHardened) {
    // Hardened child: HMAC-SHA512(Key = chainCode, Data = 0x00 || parentKey || index)
    data = new Uint8Array(1 + 32 + 4)
    data[0] = 0x00
    data.set(parentKey, 1)
    data[33] = (index >>> 24) & 0xff
    data[34] = (index >>> 16) & 0xff
    data[35] = (index >>> 8) & 0xff
    data[36] = index & 0xff
  } else {
    // Normal child: HMAC-SHA512(Key = chainCode, Data = publicKey || index)
    const publicKey = p256.getPublicKey(parentKey, true)
    data = new Uint8Array(33 + 4)
    data.set(publicKey, 0)
    data[33] = (index >>> 24) & 0xff
    data[34] = (index >>> 16) & 0xff
    data[35] = (index >>> 8) & 0xff
    data[36] = index & 0xff
  }

  const I = hmac(sha512, parentChainCode, data)
  const IL = I.slice(0, 32)
  const IR = I.slice(32)

  // For P-256, the child key = (IL + parentKey) mod n
  const ilBigInt = BigInt('0x' + bytesToHex(IL))
  const parentKeyBigInt = BigInt('0x' + bytesToHex(parentKey))
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551') // P-256 order
  const childKeyBigInt = (ilBigInt + parentKeyBigInt) % n

  if (childKeyBigInt === 0n) {
    // Extremely unlikely; retry with next index
    throw new ChainKitError(
      ErrorCode.INVALID_PATH,
      'Derived key is zero; this is astronomically unlikely.',
    )
  }

  let childKeyHex = childKeyBigInt.toString(16)
  childKeyHex = childKeyHex.padStart(64, '0')
  const childKey = hexToBytes(childKeyHex)

  return {
    key: childKey,
    chainCode: IR,
  }
}

/**
 * Derive a P-256 private key from a seed using SLIP-0010 style derivation.
 */
function p256DerivePath(seed: Uint8Array, path: string): Uint8Array {
  if (!BIP44_PATH_REGEX.test(path)) {
    throw new ChainKitError(
      ErrorCode.INVALID_PATH,
      `Invalid derivation path: "${path}". Expected format: m/44'/539'/0'/0/0`,
    )
  }

  const segments = path.split('/').slice(1) // Remove "m"
  let { key, chainCode } = p256MasterKey(seed)

  for (const segment of segments) {
    const hardened = segment.endsWith("'")
    const indexStr = hardened ? segment.slice(0, -1) : segment
    const index = parseInt(indexStr, 10)

    if (isNaN(index)) {
      throw new ChainKitError(ErrorCode.INVALID_PATH, `Invalid path segment: ${segment}`)
    }

    const childIndex = hardened ? index + 0x80000000 : index
    const child = p256DeriveChild(key, chainCode, childIndex)
    key = child.key
    chainCode = child.chainCode
  }

  return key
}

// ------- RLP Encoding for Flow Transactions -------

/**
 * An RLP item is either a byte array or a list of RLP items.
 */
type RlpItem = Uint8Array | RlpItem[]

/**
 * RLP encode a single item (byte array or nested list).
 *
 * RLP encoding rules:
 * - Single byte 0x00..0x7f: encode as itself
 * - String 0..55 bytes: 0x80 + length, then data
 * - String >55 bytes: 0xb7 + length-of-length, then length (big-endian), then data
 * - List total payload 0..55 bytes: 0xc0 + payload length, then payload
 * - List total payload >55 bytes: 0xf7 + length-of-length, then length, then payload
 */
function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    return rlpEncodeBytes(item)
  }

  // It's a list
  const encodedItems = item.map(sub => rlpEncode(sub))
  const totalLen = encodedItems.reduce((s, e) => s + e.length, 0)
  const payload = new Uint8Array(totalLen)
  let offset = 0
  for (const enc of encodedItems) {
    payload.set(enc, offset)
    offset += enc.length
  }

  if (totalLen <= 55) {
    const result = new Uint8Array(1 + totalLen)
    result[0] = 0xc0 + totalLen
    result.set(payload, 1)
    return result
  }

  const lenBytes = encodeBigEndianLength(totalLen)
  const result = new Uint8Array(1 + lenBytes.length + totalLen)
  result[0] = 0xf7 + lenBytes.length
  result.set(lenBytes, 1)
  result.set(payload, 1 + lenBytes.length)
  return result
}

/**
 * RLP encode a byte array.
 */
function rlpEncodeBytes(data: Uint8Array): Uint8Array {
  if (data.length === 1 && data[0] <= 0x7f) {
    return data
  }
  if (data.length <= 55) {
    const result = new Uint8Array(1 + data.length)
    result[0] = 0x80 + data.length
    result.set(data, 1)
    return result
  }

  const lenBytes = encodeBigEndianLength(data.length)
  const result = new Uint8Array(1 + lenBytes.length + data.length)
  result[0] = 0xb7 + lenBytes.length
  result.set(lenBytes, 1)
  result.set(data, 1 + lenBytes.length)
  return result
}

/**
 * Encode a length as big-endian bytes (minimal encoding).
 */
function encodeBigEndianLength(length: number): Uint8Array {
  if (length <= 0xff) return new Uint8Array([length])
  if (length <= 0xffff) return new Uint8Array([(length >> 8) & 0xff, length & 0xff])
  if (length <= 0xffffff) return new Uint8Array([(length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff])
  return new Uint8Array([(length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff])
}

/**
 * Convert a number to an 8-byte big-endian Uint8Array.
 */
function numberToUint64BE(value: number): Uint8Array {
  // Flow encodes 0 as empty bytes in RLP
  if (value === 0) return new Uint8Array(0)
  const buf = new Uint8Array(8)
  let v = value
  for (let i = 7; i >= 0; i--) {
    buf[i] = v & 0xff
    v = Math.floor(v / 256)
  }
  // Strip leading zeros for RLP (minimal encoding)
  let start = 0
  while (start < 7 && buf[start] === 0) start++
  return buf.slice(start)
}

/**
 * Right-pad a byte array to 32 bytes (for Flow domain separation tags).
 */
function rightPadTo32(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(32)
  padded.set(data.slice(0, 32), 0)
  return padded
}

/**
 * Concatenate multiple Uint8Arrays.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0)
  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/**
 * Convert bytes to base64 string.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Encode r and s values into DER format for signature verification.
 */
function encodeDerSignature(rBytes: Uint8Array, sBytes: Uint8Array): Uint8Array {
  // Strip leading zeros and add 0x00 prefix if high bit is set
  const encodeInt = (bytes: Uint8Array): Uint8Array => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    const trimmed = bytes.slice(start)
    if (trimmed[0] & 0x80) {
      const padded = new Uint8Array(trimmed.length + 1)
      padded[0] = 0x00
      padded.set(trimmed, 1)
      return padded
    }
    return trimmed
  }

  const rDer = encodeInt(rBytes)
  const sDer = encodeInt(sBytes)

  // DER: 0x30 [total-len] 0x02 [r-len] [r] 0x02 [s-len] [s]
  const totalLen = 2 + rDer.length + 2 + sDer.length
  const der = new Uint8Array(2 + totalLen)
  der[0] = 0x30
  der[1] = totalLen
  der[2] = 0x02
  der[3] = rDer.length
  der.set(rDer, 4)
  der[4 + rDer.length] = 0x02
  der[5 + rDer.length] = sDer.length
  der.set(sDer, 6 + rDer.length)

  return der
}

/**
 * Flow signer implementing the ChainSigner interface.
 * Uses ECDSA P-256 (secp256r1, NIST P-256) for key generation and signing.
 *
 * HD Path: m/44'/539'/0'/0/0 (BIP44 coin type 539 for Flow)
 * Address: Flow addresses are assigned by the network (8 bytes, 16 hex chars).
 *          getAddress() returns a SHA-256 hash of the public key as a deterministic identifier.
 *
 * Crypto: ECDSA_P256 via @noble/curves/p256
 */
export class FlowSigner implements ChainSigner {
  constructor(_network?: 'mainnet' | 'testnet') {}

  getDefaultHdPath(): string {
    return "m/44'/539'/0'/0/0"
  }

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
   * Derive a P-256 private key from a mnemonic using SLIP-0010 style derivation.
   * Returns a '0x'-prefixed hex string of the 32-byte private key.
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKey = p256DerivePath(seed, path)
    return addHexPrefix(bytesToHex(privateKey))
  }

  /**
   * Get a deterministic address identifier for a given private key.
   *
   * Flow addresses are NOT derived from public keys - they are assigned by the
   * network when an account is created. This method returns a SHA-256 hash of
   * the uncompressed public key, formatted as 0x + 16 hex chars (8 bytes),
   * to serve as a deterministic placeholder identifier.
   *
   * The actual on-chain Flow address must be obtained by creating an account
   * on the Flow network.
   */
  getAddress(privateKey: HexString): Address {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get the uncompressed public key (65 bytes: 04 + x + y)
    const publicKey = p256.getPublicKey(pkBytes, false)

    // SHA-256 hash of the public key
    const hash = sha256(publicKey)

    // Take last 8 bytes (16 hex chars) to match Flow address format
    const addressBytes = hash.slice(-8)
    return '0x' + bytesToHex(addressBytes)
  }

  /**
   * Get the uncompressed public key (without 04 prefix) for a given private key.
   * This is used for Flow account key registration.
   */
  getPublicKey(privateKey: HexString): HexString {
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))

    if (pkBytes.length !== 32) {
      throw new ChainKitError(
        ErrorCode.INVALID_PRIVATE_KEY,
        `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
      )
    }

    // Get uncompressed public key and strip the 04 prefix
    const publicKey = p256.getPublicKey(pkBytes, false)
    return addHexPrefix(bytesToHex(publicKey.slice(1)))
  }

  /**
   * Sign a Flow transaction.
   *
   * Two modes of operation:
   *
   * 1. Raw mode: tx.data contains a pre-encoded hex payload to sign directly.
   * 2. Transfer mode: tx.to, tx.value, and tx.extra contain transfer parameters.
   *    In this mode, a Cadence transfer script is built, RLP-encoded, and signed.
   *    Required tx.extra fields for transfer mode:
   *      - senderAddress: string (the Flow account address, e.g., "0x1234abcd1234abcd")
   *      - keyIndex: number (default: 0)
   *      - sequenceNumber: number (account key sequence number)
   *      - gasLimit: number (default: 9999)
   *      - referenceBlockId: string (recent block ID hex)
   *      - fungibleTokenAddress: string (FungibleToken contract address for the network)
   *      - flowTokenAddress: string (FlowToken contract address for the network)
   *      - hashAlgorithm: string ("SHA3_256" | "SHA2_256", default: "SHA3_256")
   *
   * Returns the ECDSA P-256 signature as a hex string (r || s, each 32 bytes)
   * in raw mode, or a JSON string containing the full transaction body ready
   * for broadcast via POST /v1/transactions in transfer mode.
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    try {

      if (pkBytes.length !== 32) {
        throw new ChainKitError(
          ErrorCode.INVALID_PRIVATE_KEY,
          `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
        )
      }

      // Raw mode: tx.data is already an encoded payload
      if (tx.data && !tx.to) {
        const messageBytes = hexToBytes(stripHexPrefix(tx.data as string))
        const msgHash = sha256(messageBytes)
        const signature = p256.sign(msgHash, pkBytes)

        const rHex = signature.r.toString(16).padStart(64, '0')
        const sHex = signature.s.toString(16).padStart(64, '0')
        return addHexPrefix(rHex + sHex)
      }

      // Transfer mode: build a full Flow transaction
      if (!tx.to || !tx.value) {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'Transaction must have either data (raw payload) or to + value (FLOW transfer)',
        )
      }

      const senderAddress = stripHexPrefix(tx.extra?.senderAddress as string ?? tx.from as string)
      const keyIndex = (tx.extra?.keyIndex as number) ?? 0
      const sequenceNumber = (tx.extra?.sequenceNumber as number) ?? 0
      const gasLimit = (tx.extra?.gasLimit as number) ?? 9999
      const referenceBlockId = tx.extra?.referenceBlockId as string
      const fungibleTokenAddr = tx.extra?.fungibleTokenAddress as string ?? '0xf233dcee88fe0abe'
      const flowTokenAddr = tx.extra?.flowTokenAddress as string ?? '0x1654653399040a61'
      // Flow accounts specify a hashing algorithm for their keys.
      // SHA3_256 is the default for most Flow accounts.
      const hashAlgorithm = (tx.extra?.hashAlgorithm as string) ?? 'SHA3_256'
      const hashFn = hashAlgorithm === 'SHA2_256' ? sha256 : sha3_256

      if (!referenceBlockId) {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'referenceBlockId is required in tx.extra for Flow transfer mode',
        )
      }

      const recipientAddress = tx.to
      // Value is in 10^-8 FLOW units, convert to UFix64 string (8 decimal places)
      const amountValue = BigInt(tx.value as string)
      const wholePart = amountValue / 100_000_000n
      const fracPart = amountValue % 100_000_000n
      const amountUFix64 = `${wholePart}.${fracPart.toString().padStart(8, '0')}`

      // Build the Cadence script for FLOW transfer
      const script = [
        `import FungibleToken from ${fungibleTokenAddr}`,
        `import FlowToken from ${flowTokenAddr}`,
        '',
        'transaction(amount: UFix64, to: Address) {',
        '    prepare(signer: auth(BorrowValue) &Account) {',
        '        let vaultRef = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(from: /storage/flowTokenVault)!',
        '        let sentVault <- vaultRef.withdraw(amount: amount)',
        '        let receiverRef = getAccount(to).capabilities.get<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)!.borrow()!',
        '        receiverRef.deposit(from: <-sentVault)',
        '    }',
        '}',
      ].join('\n')

      // Build JSON-Cadence arguments
      const args = [
        { type: 'UFix64', value: amountUFix64 },
        { type: 'Address', value: recipientAddress.startsWith('0x') ? recipientAddress : '0x' + recipientAddress },
      ]

      // Build the transaction payload for RLP encoding
      // Flow transaction payload structure:
      // [script, arguments, referenceBlockId, gasLimit, proposalKey, payer, authorizers]
      // proposalKey = [address, keyIndex, sequenceNumber]

      const scriptBase64 = bytesToBase64(new TextEncoder().encode(script))
      const argsBase64 = args.map(a => bytesToBase64(new TextEncoder().encode(JSON.stringify(a))))

      // RLP encode the payload for signing
      // Flow's canonical form is a FLAT structure (not nested for proposal key):
      // [script, arguments, refBlockID, gasLimit, proposalKeyAddress, proposalKeyID, proposalKeySeqNum, payer, authorizers]
      const payloadItems: RlpItem = [
        new TextEncoder().encode(script),                                  // script
        args.map(a => new TextEncoder().encode(JSON.stringify(a))),       // arguments
        hexToBytes(stripHexPrefix(referenceBlockId)),                      // reference block ID
        numberToUint64BE(gasLimit),                                        // gas limit
        hexToBytes(senderAddress.padStart(16, '0')),                      // proposal key address (8 bytes)
        numberToUint64BE(keyIndex),                                        // proposal key index
        numberToUint64BE(sequenceNumber),                                  // proposal key sequence number
        hexToBytes(senderAddress.padStart(16, '0')),                      // payer
        [hexToBytes(senderAddress.padStart(16, '0'))],                    // authorizers
      ]

      const payloadEncoded = rlpEncode(payloadItems)

      // Domain separation tag for transaction payload
      const domainTag = rightPadTo32(new TextEncoder().encode('FLOW-V0.0-transaction'))
      const payloadMessage = concatBytes(domainTag, payloadEncoded)

      // For single-signer (proposer == payer == authorizer), payload_signatures
      // are empty and only the envelope signature is needed. The payer signs the
      // envelope which wraps the payload + empty payload_signatures.
      // Build the envelope (payload + empty payload signatures)
      const envelopeItems: RlpItem = [
        payloadItems,                                                      // payload
        [],                                                                // payload signatures (empty for single-signer)
      ]

      const envelopeEncoded = rlpEncode(envelopeItems)

      // Sign the envelope using the account's hashing algorithm
      const envelopeMessage = concatBytes(domainTag, envelopeEncoded)
      const envelopeHash = hashFn(envelopeMessage)
      const envelopeSig = p256.sign(envelopeHash, pkBytes)
      const envelopeSigHex = envelopeSig.r.toString(16).padStart(64, '0') + envelopeSig.s.toString(16).padStart(64, '0')

      // Build the REST API transaction body
      const txBody = {
        script: scriptBase64,
        arguments: argsBase64,
        reference_block_id: stripHexPrefix(referenceBlockId),
        gas_limit: gasLimit.toString(),
        proposal_key: {
          address: senderAddress.padStart(16, '0'),
          key_index: keyIndex.toString(),
          sequence_number: sequenceNumber.toString(),
        },
        payer: senderAddress.padStart(16, '0'),
        authorizers: [senderAddress.padStart(16, '0')],
        payload_signatures: [],
        envelope_signatures: [
          {
            address: senderAddress.padStart(16, '0'),
            key_index: keyIndex.toString(),
            signature: bytesToBase64(hexToBytes(envelopeSigHex)),
          },
        ],
      }

      // Return as JSON string (broadcastTransaction expects this)
      return JSON.stringify(txBody)
    } finally {
      pkBytes.fill(0)
    }
  }

  /**
   * Validate a Flow address.
   * Flow addresses are 0x-prefixed 16-character hex strings (8 bytes).
   */
  validateAddress(address: string): boolean {
    try {
      if (!address.startsWith('0x')) return false
      const hex = address.slice(2)
      if (hex.length !== 16) return false
      return /^[0-9a-fA-F]{16}$/.test(hex)
    } catch {
      return false
    }
  }

  /**
   * Sign an arbitrary message with ECDSA P-256.
   * The message is SHA-256 hashed before signing.
   * Returns the signature as r (32 bytes) + s (32 bytes) hex string.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    try {

      if (pkBytes.length !== 32) {
        throw new ChainKitError(
          ErrorCode.INVALID_PRIVATE_KEY,
          `Invalid private key length: expected 32 bytes, got ${pkBytes.length}`,
        )
      }

      const msgBytes =
        typeof message === 'string' ? new TextEncoder().encode(message) : message

      // SHA-256 hash for signing
      const msgHash = sha256(msgBytes)

      // Sign with P-256
      const signature = p256.sign(msgHash, pkBytes)

      // Encode as r (32 bytes) + s (32 bytes)
      const rHex = signature.r.toString(16).padStart(64, '0')
      const sHex = signature.s.toString(16).padStart(64, '0')

      return addHexPrefix(rHex + sHex)
    } finally {
      pkBytes.fill(0)
    }
  }

  /**
   * Verify an ECDSA P-256 signature.
   * @param message - The original message (will be SHA-256 hashed)
   * @param signature - The signature as hex (r || s, each 32 bytes)
   * @param publicKey - The uncompressed public key (without 04 prefix) as hex
   */
  verifySignature(
    message: string | Uint8Array,
    signature: HexString,
    publicKey: HexString,
  ): boolean {
    const sigBytes = hexToBytes(stripHexPrefix(signature))
    if (sigBytes.length !== 64) return false

    const msgBytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message
    const msgHash = sha256(msgBytes)

    // Reconstruct full uncompressed public key with 04 prefix
    const pubKeyHex = stripHexPrefix(publicKey)
    const fullPubKey = hexToBytes('04' + pubKeyHex)

    try {
      // p256.verify expects a DER-encoded signature or compact signature
      // Convert r||s (64 bytes) to DER format
      const rBytes = sigBytes.slice(0, 32)
      const sBytes = sigBytes.slice(32)

      const derSig = encodeDerSignature(rBytes, sBytes)
      return p256.verify(derSig, msgHash, fullPubKey)
    } catch {
      return false
    }
  }
}
