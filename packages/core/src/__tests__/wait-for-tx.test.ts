import { describe, it, expect, vi } from 'vitest'
import { waitForTransaction } from '../utils/wait-for-tx.js'
import { ChainKitError, ErrorCode } from '../types/errors.js'
import type { TransactionInfo } from '../types/common.js'

const confirmedTx: TransactionInfo = {
  hash: '0xabc',
  from: '0xfrom',
  to: '0xto',
  value: '1000',
  fee: '21000',
  blockNumber: 100,
  blockHash: '0xblockhash',
  status: 'confirmed',
  timestamp: 1700000000,
}

const pendingTx: TransactionInfo = {
  hash: '0xabc',
  from: '0xfrom',
  to: '0xto',
  value: '1000',
  fee: '0',
  blockNumber: null,
  blockHash: null,
  status: 'pending',
  timestamp: null,
}

const failedTx: TransactionInfo = {
  hash: '0xabc',
  from: '0xfrom',
  to: '0xto',
  value: '1000',
  fee: '21000',
  blockNumber: 100,
  blockHash: '0xblockhash',
  status: 'failed',
  timestamp: 1700000000,
}

describe('waitForTransaction', () => {
  it('should return immediately when tx is already confirmed', async () => {
    const getTransaction = vi.fn().mockResolvedValue(confirmedTx)

    const result = await waitForTransaction(getTransaction, '0xabc', {
      intervalMs: 10,
    })

    expect(result).toEqual(confirmedTx)
    expect(getTransaction).toHaveBeenCalledTimes(1)
  })

  it('should poll until tx is confirmed', async () => {
    let callCount = 0
    const getTransaction = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount < 3) return pendingTx
      return confirmedTx
    })

    const result = await waitForTransaction(getTransaction, '0xabc', {
      intervalMs: 10,
    })

    expect(result).toEqual(confirmedTx)
    expect(getTransaction).toHaveBeenCalledTimes(3)
  })

  it('should throw on failed transaction', async () => {
    const getTransaction = vi.fn().mockResolvedValue(failedTx)

    await expect(
      waitForTransaction(getTransaction, '0xabc', { intervalMs: 10 }),
    ).rejects.toThrow(ChainKitError)

    await expect(
      waitForTransaction(getTransaction, '0xabc', { intervalMs: 10 }),
    ).rejects.toMatchObject({
      code: ErrorCode.TRANSACTION_FAILED,
    })
  })

  it('should throw on timeout', async () => {
    const getTransaction = vi.fn().mockResolvedValue(pendingTx)

    await expect(
      waitForTransaction(getTransaction, '0xabc', {
        timeoutMs: 50,
        intervalMs: 10,
      }),
    ).rejects.toThrow(ChainKitError)

    await expect(
      waitForTransaction(getTransaction, '0xabc', {
        timeoutMs: 50,
        intervalMs: 10,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
    })
  })

  it('should keep polling when getTransaction returns null (tx not found yet)', async () => {
    let callCount = 0
    const getTransaction = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount < 3) return null
      return confirmedTx
    })

    const result = await waitForTransaction(getTransaction, '0xabc', {
      intervalMs: 10,
    })

    expect(result).toEqual(confirmedTx)
    expect(getTransaction).toHaveBeenCalledTimes(3)
  })

  it('should keep polling when getTransaction throws a network error', async () => {
    let callCount = 0
    const getTransaction = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) throw new Error('Network error')
      return confirmedTx
    })

    const result = await waitForTransaction(getTransaction, '0xabc', {
      intervalMs: 10,
    })

    expect(result).toEqual(confirmedTx)
    expect(getTransaction).toHaveBeenCalledTimes(2)
  })

  it('should use default timeout and interval', async () => {
    const getTransaction = vi.fn().mockResolvedValue(confirmedTx)

    const result = await waitForTransaction(getTransaction, '0xabc')

    expect(result).toEqual(confirmedTx)
  })
})
