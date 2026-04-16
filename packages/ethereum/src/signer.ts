import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  derivePath,
  ChainKitError,
  ErrorCode,
} from '@chainkit/core'
import type { ChainSigner, HexString, Address, UnsignedTx, SignTransactionParams, SignMessageParams, EvmSignerCapable, TypedDataDomain, TypedDataField } from '@chainkit/core'
import { keccak_256 } from '@noble/hashes/sha3'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import * as secp256k1 from '@noble/secp256k1'

// @noble/secp256k1 v2 requires manually setting the hmac function
secp256k1.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) => {
  return hmac(sha256, k, secp256k1.etc.concatBytes(...m))
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
 * Compute EIP-55 checksum address from a raw 20-byte hex address.
 */
function toChecksumAddress(address: string): string {
  const addr = stripHexPrefix(address).toLowerCase()
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(addr)))

  let checksummed = '0x'
  for (let i = 0; i < 40; i++) {
    if (parseInt(hash[i], 16) >= 8) {
      checksummed += addr[i].toUpperCase()
    } else {
      checksummed += addr[i]
    }
  }
  return checksummed
}

/**
 * RLP encode a single item (string/bytes or list).
 */
function rlpEncode(input: Uint8Array | Uint8Array[]): Uint8Array {
  if (input instanceof Uint8Array) {
    return rlpEncodeBytes(input)
  }
  // Encode list
  const encoded = input.map((item) => rlpEncode(item))
  const totalLength = encoded.reduce((sum, buf) => sum + buf.length, 0)
  const lengthPrefix = rlpEncodeLength(totalLength, 192)
  const result = new Uint8Array(lengthPrefix.length + totalLength)
  result.set(lengthPrefix, 0)
  let offset = lengthPrefix.length
  for (const buf of encoded) {
    result.set(buf, offset)
    offset += buf.length
  }
  return result
}

function rlpEncodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] < 128) {
    return bytes
  }
  if (bytes.length <= 55) {
    const result = new Uint8Array(1 + bytes.length)
    result[0] = 128 + bytes.length
    result.set(bytes, 1)
    return result
  }
  const lenBytes = toMinimalBytes(bytes.length)
  const result = new Uint8Array(1 + lenBytes.length + bytes.length)
  result[0] = 183 + lenBytes.length
  result.set(lenBytes, 1)
  result.set(bytes, 1 + lenBytes.length)
  return result
}

function rlpEncodeLength(length: number, offset: number): Uint8Array {
  if (length <= 55) {
    return new Uint8Array([offset + length])
  }
  const lenBytes = toMinimalBytes(length)
  const result = new Uint8Array(1 + lenBytes.length)
  result[0] = offset + 55 + lenBytes.length
  result.set(lenBytes, 1)
  return result
}

function toMinimalBytes(value: number): Uint8Array {
  if (value === 0) return new Uint8Array([])
  const hex = value.toString(16)
  const padded = hex.length % 2 === 0 ? hex : '0' + hex
  return hexToBytes(padded)
}

/**
 * Convert a hex string (possibly with 0x prefix) to minimal bytes for RLP encoding.
 * Strips leading zeros.
 */
function hexToMinimalBytes(hex: string): Uint8Array {
  const stripped = stripHexPrefix(hex)
  if (stripped === '' || stripped === '0') return new Uint8Array([])
  // Remove leading zeros
  let clean = stripped.replace(/^0+/, '')
  if (clean === '') return new Uint8Array([])
  if (clean.length % 2 !== 0) clean = '0' + clean
  return hexToBytes(clean)
}

/**
 * Convert a decimal string to minimal bytes for RLP encoding.
 */
function decimalToMinimalBytes(dec: string): Uint8Array {
  const n = BigInt(dec)
  if (n === 0n) return new Uint8Array([])
  let hex = n.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return hexToBytes(hex)
}

/**
 * Convert a number to minimal bytes for RLP encoding.
 */
function numberToMinimalBytes(num: number): Uint8Array {
  if (num === 0) return new Uint8Array([])
  let hex = num.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return hexToBytes(hex)
}

/**
 * Ethereum signer implementing the ChainSigner interface.
 * Supports BIP39/BIP32 key derivation, EIP-191 message signing,
 * and EIP-1559 (type 2) / legacy transaction signing.
 */
export class EthereumSigner implements ChainSigner, EvmSignerCapable {
  /**
   * @param _network - Accepted for interface consistency but not used for address generation.
   *   EVM addresses are the same on mainnet and testnet.
   */
  constructor(_network?: 'mainnet' | 'testnet') {
    // Network does not affect EVM address generation
  }

  /**
   * Get the default BIP44 HD derivation path for Ethereum.
   */
  getDefaultHdPath(): string {
    return "m/44'/60'/0'/0/0"
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
   * Derive a private key from a mnemonic using a BIP44 HD path.
   * Returns a '0x'-prefixed hex string.
   */
  async derivePrivateKey(mnemonic: string, path: string): Promise<HexString> {
    const seed = await mnemonicToSeed(mnemonic)
    const privateKeyHex = derivePath(seed, path)
    return addHexPrefix(privateKeyHex)
  }

  /**
   * Get the Ethereum address for a given private key.
   * Returns an EIP-55 checksummed address.
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
    const publicKey = secp256k1.getPublicKey(pkBytes, false)

    // Take the keccak256 hash of the public key bytes (without the 04 prefix)
    const hash = keccak_256(publicKey.slice(1))

    // Take the last 20 bytes as the address
    const addressBytes = hash.slice(-20)
    return toChecksumAddress(bytesToHex(addressBytes))
  }

  /**
   * Sign an Ethereum transaction.
   *
   * Supports EIP-1559 (type 2) transactions when chainId is provided in extra,
   * and legacy transactions as fallback.
   */
  async signTransaction(params: SignTransactionParams): Promise<HexString> {
    const { privateKey, tx } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    try {
      const chainId = tx.extra?.chainId as number | undefined
      if (chainId === undefined) {
        throw new ChainKitError(
          ErrorCode.INVALID_PARAMS,
          'chainId is required in tx.extra for EIP-155 replay protection',
        )
      }
      const nonce = tx.nonce ?? 0
      const to = hexToBytes(stripHexPrefix(tx.to))
      const value = tx.value ? decimalToMinimalBytes(tx.value) : new Uint8Array([])
      const data = tx.data ? hexToBytes(stripHexPrefix(tx.data as string)) : new Uint8Array([])

      // Determine transaction type
      const isEip1559 = tx.fee?.maxFeePerGas !== undefined

      if (isEip1559) {
        // EIP-1559 (Type 2) transaction
        const maxPriorityFeePerGas = tx.fee?.maxPriorityFeePerGas
          ? hexToMinimalBytes(tx.fee.maxPriorityFeePerGas as string)
          : new Uint8Array([])
        const maxFeePerGas = tx.fee?.maxFeePerGas
          ? hexToMinimalBytes(tx.fee.maxFeePerGas as string)
          : new Uint8Array([])
        const gasLimit = tx.fee?.gasLimit
          ? hexToMinimalBytes(tx.fee.gasLimit as string)
          : hexToMinimalBytes('0x5208') // 21000 default

        // EIP-1559 payload: [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList]
        const fields: Uint8Array[] = [
          numberToMinimalBytes(chainId),
          numberToMinimalBytes(nonce),
          maxPriorityFeePerGas,
          maxFeePerGas,
          gasLimit,
          to,
          value,
          data,
          new Uint8Array([]), // empty access list (encoded as empty list placeholder - we'll handle below)
        ]

        // For the access list, we need an empty RLP list
        const rlpPayload = rlpEncodeEip1559Fields(fields)

        // Prepend transaction type byte (0x02) for signing
        const signingPayload = new Uint8Array(1 + rlpPayload.length)
        signingPayload[0] = 0x02
        signingPayload.set(rlpPayload, 1)

        // Hash for signing
        const msgHash = keccak_256(signingPayload)
        const signature = secp256k1.sign(msgHash, pkBytes)

        const r = signature.r
        const s = signature.s
        const v = signature.recovery

        // Encode signed transaction
        let rHex = r.toString(16)
        if (rHex.length % 2 !== 0) rHex = '0' + rHex
        let sHex = s.toString(16)
        if (sHex.length % 2 !== 0) sHex = '0' + sHex

        const signedFields: Uint8Array[] = [
          numberToMinimalBytes(chainId),
          numberToMinimalBytes(nonce),
          maxPriorityFeePerGas,
          maxFeePerGas,
          gasLimit,
          to,
          value,
          data,
          new Uint8Array([]), // access list placeholder
        ]

        // Add v, r, s
        const vBytes = numberToMinimalBytes(v)
        const rBytes = hexToBytes(rHex)
        const sBytes = hexToBytes(sHex)

        const signedRlp = rlpEncodeEip1559Signed(signedFields, vBytes, rBytes, sBytes)
        const signedTx = new Uint8Array(1 + signedRlp.length)
        signedTx[0] = 0x02
        signedTx.set(signedRlp, 1)

        return addHexPrefix(bytesToHex(signedTx))
      } else {
        // Legacy transaction
        const gasPrice = tx.fee?.gasPrice
          ? hexToMinimalBytes(tx.fee.gasPrice as string)
          : new Uint8Array([])
        const gasLimit = tx.fee?.gasLimit
          ? hexToMinimalBytes(tx.fee.gasLimit as string)
          : hexToMinimalBytes('0x5208')

        // EIP-155 signing: [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
        const signingFields: Uint8Array[] = [
          numberToMinimalBytes(nonce),
          gasPrice,
          gasLimit,
          to,
          value,
          data,
          numberToMinimalBytes(chainId),
          new Uint8Array([]),
          new Uint8Array([]),
        ]

        const signingRlp = rlpEncode(signingFields)
        const msgHash = keccak_256(signingRlp)
        const signature = secp256k1.sign(msgHash, pkBytes)

        const r = signature.r
        const s = signature.s
        // EIP-155: v = recovery + chainId * 2 + 35
        const vVal = signature.recovery + chainId * 2 + 35

        let rHex = r.toString(16)
        if (rHex.length % 2 !== 0) rHex = '0' + rHex
        let sHex = s.toString(16)
        if (sHex.length % 2 !== 0) sHex = '0' + sHex

        const signedFields: Uint8Array[] = [
          numberToMinimalBytes(nonce),
          gasPrice,
          gasLimit,
          to,
          value,
          data,
          numberToMinimalBytes(vVal),
          hexToBytes(rHex),
          hexToBytes(sHex),
        ]

        const signedRlp = rlpEncode(signedFields)
        return addHexPrefix(bytesToHex(signedRlp))
      }
    } finally {
      pkBytes.fill(0)
    }
  }

  /**
   * Validate an Ethereum address.
   * Checks for 0x prefix, 40 hex characters, and optional EIP-55 checksum.
   */
  validateAddress(address: string): boolean {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false
    // If mixed case, verify EIP-55 checksum
    const lower = address.slice(2).toLowerCase()
    const upper = address.slice(2).toUpperCase()
    if (address.slice(2) !== lower && address.slice(2) !== upper) {
      return toChecksumAddress(address) === address
    }
    return true
  }

  /**
   * Sign an arbitrary message using EIP-191 personal_sign.
   * Prepends the standard Ethereum message prefix.
   */
  async signMessage(params: SignMessageParams): Promise<HexString> {
    const { privateKey, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    try {

      // Convert message to bytes
      const msgBytes =
        typeof message === 'string' ? new TextEncoder().encode(message) : message

      // EIP-191 prefix: "\x19Ethereum Signed Message:\n" + message length
      const prefix = new TextEncoder().encode(
        `\x19Ethereum Signed Message:\n${msgBytes.length}`,
      )
      const prefixedMsg = new Uint8Array(prefix.length + msgBytes.length)
      prefixedMsg.set(prefix, 0)
      prefixedMsg.set(msgBytes, prefix.length)

      // Hash the prefixed message
      const msgHash = keccak_256(prefixedMsg)

      // Sign
      const signature = secp256k1.sign(msgHash, pkBytes)

      // Encode as r (32 bytes) + s (32 bytes) + v (1 byte)
      let rHex = signature.r.toString(16).padStart(64, '0')
      let sHex = signature.s.toString(16).padStart(64, '0')
      const v = signature.recovery + 27

      return addHexPrefix(rHex + sHex + v.toString(16).padStart(2, '0'))
    } finally {
      pkBytes.fill(0)
    }
  }

  /**
   * Sign EIP-712 typed structured data.
   *
   * Process:
   * 1. Build type hash for each struct type
   * 2. Encode domain separator: keccak256(EIP712Domain typeHash + encoded domain)
   * 3. Encode struct data recursively
   * 4. Final hash: keccak256("\x19\x01" + domainSeparator + structHash)
   * 5. secp256k1 sign the final hash
   */
  async signTypedData(params: {
    privateKey: string
    domain: TypedDataDomain
    types: Record<string, TypedDataField[]>
    primaryType: string
    message: Record<string, unknown>
  }): Promise<string> {
    const { privateKey, domain, types, primaryType, message } = params
    const pkBytes = hexToBytes(stripHexPrefix(privateKey))
    try {

      // Build the EIP712Domain type
      const domainFields: TypedDataField[] = []
      if (domain.name !== undefined) domainFields.push({ name: 'name', type: 'string' })
      if (domain.version !== undefined) domainFields.push({ name: 'version', type: 'string' })
      if (domain.chainId !== undefined) domainFields.push({ name: 'chainId', type: 'uint256' })
      if (domain.verifyingContract !== undefined) domainFields.push({ name: 'verifyingContract', type: 'address' })
      if (domain.salt !== undefined) domainFields.push({ name: 'salt', type: 'bytes32' })

      const allTypes: Record<string, TypedDataField[]> = { ...types, EIP712Domain: domainFields }

      const encodeType = (typeName: string): string => {
        const fields = allTypes[typeName]
        if (!fields) throw new ChainKitError(ErrorCode.INVALID_PARAMS, `Unknown type: ${typeName}`)
        let result = `${typeName}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`
        // Collect and sort referenced types
        const refs = new Set<string>()
        const collectRefs = (tName: string) => {
          for (const field of allTypes[tName] || []) {
            const baseType = field.type.replace(/\[\d*\]$/, '')
            if (allTypes[baseType] && baseType !== typeName && !refs.has(baseType)) {
              refs.add(baseType)
              collectRefs(baseType)
            }
          }
        }
        collectRefs(typeName)
        const sortedRefs = [...refs].sort()
        for (const ref of sortedRefs) {
          const refFields = allTypes[ref]
          result += `${ref}(${refFields.map((f) => `${f.type} ${f.name}`).join(',')})`
        }
        return result
      }

      const hashType = (typeName: string): Uint8Array => {
        return keccak_256(new TextEncoder().encode(encodeType(typeName)))
      }

      const encodeValue = (type: string, value: unknown): Uint8Array => {
        if (type === 'string') {
          return keccak_256(new TextEncoder().encode(value as string))
        }
        if (type === 'bytes') {
          const v = value as string
          return keccak_256(hexToBytes(stripHexPrefix(v)))
        }
        if (allTypes[type]) {
          return encodeData(type, value as Record<string, unknown>)
        }
        if (type === 'address') {
          const addr = stripHexPrefix(value as string).toLowerCase().padStart(64, '0')
          return hexToBytes(addr)
        }
        if (type === 'bool') {
          return hexToBytes((value ? '1' : '0').padStart(64, '0'))
        }
        if (type.startsWith('uint') || type.startsWith('int')) {
          const n = BigInt(value as string | number | bigint)
          let hex = (n >= 0n ? n : (1n << 256n) + n).toString(16).padStart(64, '0')
          return hexToBytes(hex)
        }
        if (type.startsWith('bytes')) {
          const v = stripHexPrefix(value as string)
          return hexToBytes(v.padEnd(64, '0'))
        }
        // Default: treat as uint256
        const n = BigInt(value as string | number)
        return hexToBytes(n.toString(16).padStart(64, '0'))
      }

      const encodeData = (typeName: string, data: Record<string, unknown>): Uint8Array => {
        const fields = allTypes[typeName]
        if (!fields) throw new ChainKitError(ErrorCode.INVALID_PARAMS, `Unknown type: ${typeName}`)
        const typeHash = hashType(typeName)
        const parts: Uint8Array[] = [typeHash]
        for (const field of fields) {
          parts.push(encodeValue(field.type, data[field.name]))
        }
        const totalLen = parts.reduce((s, p) => s + p.length, 0)
        const combined = new Uint8Array(totalLen)
        let offset = 0
        for (const p of parts) {
          combined.set(p, offset)
          offset += p.length
        }
        return keccak_256(combined)
      }

      // Encode domain separator
      const domainData: Record<string, unknown> = {}
      if (domain.name !== undefined) domainData.name = domain.name
      if (domain.version !== undefined) domainData.version = domain.version
      if (domain.chainId !== undefined) domainData.chainId = domain.chainId
      if (domain.verifyingContract !== undefined) domainData.verifyingContract = domain.verifyingContract
      if (domain.salt !== undefined) domainData.salt = domain.salt
      const domainSeparator = encodeData('EIP712Domain', domainData)

      // Encode struct hash
      const structHash = encodeData(primaryType, message)

      // Final hash: keccak256("\x19\x01" + domainSeparator + structHash)
      const finalPayload = new Uint8Array(2 + 32 + 32)
      finalPayload[0] = 0x19
      finalPayload[1] = 0x01
      finalPayload.set(domainSeparator, 2)
      finalPayload.set(structHash, 34)
      const finalHash = keccak_256(finalPayload)

      // Sign
      const signature = secp256k1.sign(finalHash, pkBytes)
      const rHex = signature.r.toString(16).padStart(64, '0')
      const sHex = signature.s.toString(16).padStart(64, '0')
      const v = signature.recovery + 27

      return addHexPrefix(rHex + sHex + v.toString(16).padStart(2, '0'))
    } finally {
      pkBytes.fill(0)
    }
  }
}

/**
 * RLP encode EIP-1559 fields with empty access list (for signing).
 * The access list is the 9th field and must be encoded as an empty RLP list (0xc0).
 */
function rlpEncodeEip1559Fields(fields: Uint8Array[]): Uint8Array {
  // Encode all fields except the last (access list placeholder)
  const encodedFields: Uint8Array[] = []
  for (let i = 0; i < fields.length - 1; i++) {
    encodedFields.push(rlpEncode(fields[i]))
  }
  // Access list: empty list = 0xc0
  encodedFields.push(new Uint8Array([0xc0]))

  const totalLength = encodedFields.reduce((sum, buf) => sum + buf.length, 0)
  const lengthPrefix = rlpEncodeLength(totalLength, 192)
  const result = new Uint8Array(lengthPrefix.length + totalLength)
  result.set(lengthPrefix, 0)
  let offset = lengthPrefix.length
  for (const buf of encodedFields) {
    result.set(buf, offset)
    offset += buf.length
  }
  return result
}

/**
 * RLP encode signed EIP-1559 transaction (fields + v, r, s).
 */
function rlpEncodeEip1559Signed(
  fields: Uint8Array[],
  v: Uint8Array,
  r: Uint8Array,
  s: Uint8Array,
): Uint8Array {
  const encodedFields: Uint8Array[] = []
  for (let i = 0; i < fields.length - 1; i++) {
    encodedFields.push(rlpEncode(fields[i]))
  }
  // Access list: empty list
  encodedFields.push(new Uint8Array([0xc0]))
  // v, r, s
  encodedFields.push(rlpEncode(v))
  encodedFields.push(rlpEncode(r))
  encodedFields.push(rlpEncode(s))

  const totalLength = encodedFields.reduce((sum, buf) => sum + buf.length, 0)
  const lengthPrefix = rlpEncodeLength(totalLength, 192)
  const result = new Uint8Array(lengthPrefix.length + totalLength)
  result.set(lengthPrefix, 0)
  let offset = lengthPrefix.length
  for (const buf of encodedFields) {
    result.set(buf, offset)
    offset += buf.length
  }
  return result
}
