import { ChainKitError, ErrorCode } from '../types/errors.js'
import type { TransactionInfo } from '../types/common.js'

/**
 * Options for waiting on a transaction confirmation.
 */
export interface WaitForTransactionOptions {
  /** Maximum time to wait in milliseconds (default: 60000 = 1 minute) */
  timeoutMs?: number
  /** Polling interval in milliseconds (default: 3000 = 3 seconds) */
  intervalMs?: number
  /** Number of confirmations to wait for (default: 1). Currently checks status only. */
  confirmations?: number
}

/**
 * Poll a transaction by hash until it reaches a terminal state (confirmed or failed).
 *
 * This is a generic helper that any chain provider can delegate to. It repeatedly
 * calls `getTransaction` until the transaction is confirmed, fails, or the timeout
 * is reached.
 *
 * @param getTransaction - Function that fetches transaction info by hash
 * @param hash - The transaction hash to watch
 * @param options - Polling configuration
 * @returns The confirmed TransactionInfo
 * @throws ChainKitError with TIMEOUT code if the timeout is exceeded
 * @throws ChainKitError with TRANSACTION_FAILED code if the transaction fails
 */
export async function waitForTransaction(
  getTransaction: (hash: string) => Promise<TransactionInfo | null>,
  hash: string,
  options?: WaitForTransactionOptions,
): Promise<TransactionInfo> {
  const timeout = options?.timeoutMs ?? 60000
  const interval = options?.intervalMs ?? 3000
  const start = Date.now()

  while (Date.now() - start < timeout) {
    try {
      const tx = await getTransaction(hash)
      if (tx) {
        if (tx.status === 'confirmed') return tx
        if (tx.status === 'failed') {
          throw new ChainKitError(
            ErrorCode.TRANSACTION_FAILED,
            `Transaction ${hash} failed`,
            { hash, transaction: tx },
          )
        }
        // status === 'pending' -> keep polling
      }
    } catch (e) {
      // Re-throw ChainKitErrors for failed transactions
      if (e instanceof ChainKitError && e.code === ErrorCode.TRANSACTION_FAILED) {
        throw e
      }
      // TX not found yet or transient network error, keep polling
    }
    await new Promise(r => setTimeout(r, interval))
  }

  throw new ChainKitError(
    ErrorCode.TIMEOUT,
    `Timed out waiting for transaction ${hash} after ${timeout}ms`,
    { hash, timeoutMs: timeout },
  )
}
