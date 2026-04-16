import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

/**
 * A wrapper around a private key stored as Uint8Array that can be
 * securely zeroed from memory when no longer needed.
 *
 * JavaScript strings are immutable and cannot be cleared from memory,
 * making hex-string private keys a security concern. SecureKey stores
 * the key material as a mutable Uint8Array and provides a destroy()
 * method to zero it out.
 *
 * Usage:
 * ```ts
 * const key = new SecureKey('0xabc...')
 * // use key.hex or key.bytes
 * key.destroy() // zeros the key material
 * ```
 */
export class SecureKey {
  private _key: Uint8Array
  private _destroyed = false

  constructor(hexOrBytes: string | Uint8Array) {
    if (typeof hexOrBytes === 'string') {
      let hex = hexOrBytes.startsWith('0x') ? hexOrBytes.slice(2) : hexOrBytes
      // Pad to even length if necessary
      if (hex.length % 2 !== 0) hex = '0' + hex
      if (hex.length === 0) {
        this._key = new Uint8Array(0)
      } else if (/^[0-9a-fA-F]+$/.test(hex)) {
        this._key = hexToBytes(hex)
      } else {
        // Non-hex string: encode as UTF-8 bytes so we can still zero it
        this._key = new TextEncoder().encode(hexOrBytes)
      }
    } else {
      this._key = new Uint8Array(hexOrBytes)
    }
  }

  /**
   * Get the raw key bytes.
   * @throws Error if the key has been destroyed
   */
  get bytes(): Uint8Array {
    if (this._destroyed) throw new Error('SecureKey has been destroyed')
    return this._key
  }

  /**
   * Get the key as a 0x-prefixed hex string.
   * @throws Error if the key has been destroyed
   */
  get hex(): string {
    if (this._destroyed) throw new Error('SecureKey has been destroyed')
    return '0x' + bytesToHex(this._key)
  }

  /**
   * Whether this key has been destroyed (zeroed).
   */
  get isDestroyed(): boolean {
    return this._destroyed
  }

  /**
   * Zero out the key material. After calling this, any attempt
   * to access .bytes or .hex will throw an error.
   */
  destroy(): void {
    this._key.fill(0)
    this._destroyed = true
  }
}
