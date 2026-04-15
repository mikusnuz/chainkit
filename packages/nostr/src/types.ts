/**
 * Nostr event data used for constructing and signing events.
 */
export interface NostrEventData {
  /** Event kind (e.g., 0 = metadata, 1 = text note, 9735 = zap receipt) */
  kind: number
  /** Event content string */
  content: string
  /** Event tags as an array of string arrays */
  tags: string[][]
}

/**
 * Fee detail for Nostr relay operations.
 */
export interface NostrFeeDetail {
  /** Fee charged by the relay (typically "0") */
  relayFee: string
}

/**
 * A signed Nostr event ready for publishing.
 */
export interface NostrEvent {
  /** Event ID (32-byte lowercase hex SHA-256 hash) */
  id: string
  /** Public key of the event creator (32-byte lowercase hex) */
  pubkey: string
  /** Unix timestamp in seconds */
  created_at: number
  /** Event kind */
  kind: number
  /** Event tags */
  tags: string[][]
  /** Event content */
  content: string
  /** Schnorr signature of the event ID (64-byte lowercase hex) */
  sig: string
}
