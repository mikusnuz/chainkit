import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RpcManager } from '../rpc/rpc-manager.js'
import { ChainKitError, ErrorCode } from '../types/errors.js'

/**
 * Create a mock fetch that parses the request body to extract the JSON-RPC id
 * and returns it in the response for proper ID validation.
 */
function createMockResponse(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
    _result: result,
  } as unknown as Response
}

/**
 * Create a mock response factory that correctly mirrors the JSON-RPC request id.
 * Use this with mockFetch.mockImplementation to get proper ID matching.
 */
function createIdAwareMockResponse(result: unknown) {
  return (_url: string, options?: { body?: string }) => {
    const id = options?.body ? JSON.parse(options.body).id : 1
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ jsonrpc: '2.0', id, result }),
    } as unknown as Response)
  }
}

function createMockErrorResponse(code: number, message: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, error: { code, message } }),
  } as unknown as Response
}

function createMockHttpErrorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.reject(new Error('not ok')),
  } as unknown as Response
}

describe('RpcManager', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('should throw if no endpoints provided', () => {
      expect(() => new RpcManager({ endpoints: [] })).toThrow(ChainKitError)
      expect(() => new RpcManager({ endpoints: [] })).toThrow('At least one RPC endpoint is required')
    })

    it('should accept valid config', () => {
      const manager = new RpcManager({ endpoints: ['http://rpc1.test'] })
      expect(manager.getEndpoints()).toEqual(['http://rpc1.test'])
      expect(manager.getStrategy()).toBe('failover')
    })

    it('should use custom strategy', () => {
      const manager = new RpcManager({ endpoints: ['http://rpc1.test'], strategy: 'round-robin' })
      expect(manager.getStrategy()).toBe('round-robin')
    })
  })

  describe('failover strategy', () => {
    it('should use the first endpoint on success', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('0x1'))

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test', 'http://rpc2.test'],
        strategy: 'failover',
      })

      const result = await manager.request('eth_blockNumber')
      expect(result).toBe('0x1')
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch.mock.calls[0][0]).toBe('http://rpc1.test')
    })

    it('should fall back to second endpoint when first fails', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce(createMockResponse('0x2'))

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test', 'http://rpc2.test'],
        strategy: 'failover',
        retries: 2,
      })

      const result = await manager.request('eth_blockNumber')
      expect(result).toBe('0x2')
    })

    it('should throw RPC_ALL_FAILED when all endpoints fail', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'))

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test', 'http://rpc2.test'],
        strategy: 'failover',
        retries: 0,
      })

      await expect(manager.request('eth_blockNumber')).rejects.toThrow(ChainKitError)
      await expect(manager.request('eth_blockNumber')).rejects.toMatchObject({
        code: ErrorCode.RPC_ALL_FAILED,
      })
    })

    it('should not retry on JSON-RPC errors (definitive)', async () => {
      mockFetch.mockResolvedValue(createMockErrorResponse(-32601, 'Method not found'))

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test', 'http://rpc2.test'],
        strategy: 'failover',
        retries: 2,
      })

      await expect(manager.request('invalid_method')).rejects.toMatchObject({
        code: ErrorCode.RPC_ERROR,
      })
      // Should only call fetch once (no retries for JSON-RPC errors)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('round-robin strategy', () => {
    it('should distribute requests across endpoints', async () => {
      mockFetch.mockImplementation(createIdAwareMockResponse('ok'))

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test', 'http://rpc2.test', 'http://rpc3.test'],
        strategy: 'round-robin',
      })

      await manager.request('eth_blockNumber')
      await manager.request('eth_blockNumber')
      await manager.request('eth_blockNumber')

      // Should have called each endpoint once (round-robin)
      expect(mockFetch.mock.calls[0][0]).toBe('http://rpc1.test')
      expect(mockFetch.mock.calls[1][0]).toBe('http://rpc2.test')
      expect(mockFetch.mock.calls[2][0]).toBe('http://rpc3.test')
    })

    it('should wrap around endpoints', async () => {
      mockFetch.mockImplementation(createIdAwareMockResponse('ok'))

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test', 'http://rpc2.test'],
        strategy: 'round-robin',
      })

      await manager.request('m1')
      await manager.request('m2')
      await manager.request('m3')

      expect(mockFetch.mock.calls[0][0]).toBe('http://rpc1.test')
      expect(mockFetch.mock.calls[1][0]).toBe('http://rpc2.test')
      expect(mockFetch.mock.calls[2][0]).toBe('http://rpc1.test')
    })

    it('should fall back to other endpoints on failure', async () => {
      let callCount = 0
      mockFetch.mockImplementation((url: string, options?: { body?: string }) => {
        callCount++
        if (url === 'http://rpc1.test') {
          return Promise.reject(new Error('down'))
        }
        const id = options?.body ? JSON.parse(options.body).id : 1
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ jsonrpc: '2.0', id, result: 'ok' }),
        } as unknown as Response)
      })

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test', 'http://rpc2.test'],
        strategy: 'round-robin',
        retries: 0,
      })

      // First request starts at rpc1, fails, falls back to rpc2
      const result = await manager.request('eth_blockNumber')
      expect(result).toBe('ok')
    })
  })

  describe('fastest strategy', () => {
    it('should return the fastest response', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === 'http://slow.test') {
          return new Promise((resolve) =>
            setTimeout(() => resolve(createMockResponse('slow')), 100),
          )
        }
        return Promise.resolve(createMockResponse('fast'))
      })

      const manager = new RpcManager({
        endpoints: ['http://slow.test', 'http://fast.test'],
        strategy: 'fastest',
      })

      const result = await manager.request('eth_blockNumber')
      expect(result).toBe('fast')
    })

    it('should succeed even if some endpoints fail', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === 'http://bad.test') {
          return Promise.reject(new Error('Connection refused'))
        }
        return Promise.resolve(createMockResponse('good'))
      })

      const manager = new RpcManager({
        endpoints: ['http://bad.test', 'http://good.test'],
        strategy: 'fastest',
      })

      const result = await manager.request('eth_blockNumber')
      expect(result).toBe('good')
    })

    it('should throw when all endpoints fail', async () => {
      mockFetch.mockRejectedValue(new Error('All down'))

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test', 'http://rpc2.test'],
        strategy: 'fastest',
      })

      await expect(manager.request('eth_blockNumber')).rejects.toMatchObject({
        code: ErrorCode.RPC_ALL_FAILED,
      })
    })

    it('should propagate JSON-RPC errors immediately', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === 'http://rpc1.test') {
          return Promise.resolve(createMockErrorResponse(-32601, 'Method not found'))
        }
        // This one is slower
        return new Promise((resolve) =>
          setTimeout(() => resolve(createMockResponse('ok')), 200),
        )
      })

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test', 'http://rpc2.test'],
        strategy: 'fastest',
      })

      await expect(manager.request('invalid_method')).rejects.toMatchObject({
        code: ErrorCode.RPC_ERROR,
      })
    })
  })

  describe('timeout', () => {
    it('should timeout on slow responses', async () => {
      mockFetch.mockImplementation((_url: string, options: { signal: AbortSignal }) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(createMockResponse('too late')), 5000)
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })
      })

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test'],
        strategy: 'failover',
        timeout: 50,
        retries: 0,
      })

      // With a single endpoint and no retries, failover wraps into RPC_ALL_FAILED
      // The underlying timeout error is captured in the context
      const err = await manager.request('eth_blockNumber').catch((e) => e)
      expect(err).toBeInstanceOf(ChainKitError)
      expect(err.code).toBe(ErrorCode.RPC_ALL_FAILED)
      expect(err.context.errors[0]).toContain('timed out')
    })
  })

  describe('HTTP errors', () => {
    it('should handle HTTP error responses', async () => {
      mockFetch.mockResolvedValue(createMockHttpErrorResponse(500, 'Internal Server Error'))

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test'],
        strategy: 'failover',
        retries: 0,
      })

      // With a single endpoint and no retries, failover wraps into RPC_ALL_FAILED
      const err = await manager.request('eth_blockNumber').catch((e) => e)
      expect(err).toBeInstanceOf(ChainKitError)
      expect(err.code).toBe(ErrorCode.RPC_ALL_FAILED)
      // The underlying error should mention HTTP 500
      expect(err.context.errors[0]).toContain('HTTP 500')
    })

    it('should retry HTTP errors', async () => {
      mockFetch
        .mockResolvedValueOnce(createMockHttpErrorResponse(503, 'Service Unavailable'))
        .mockResolvedValueOnce(createMockResponse('ok'))

      const manager = new RpcManager({
        endpoints: ['http://rpc1.test'],
        strategy: 'failover',
        retries: 1,
      })

      const result = await manager.request('eth_blockNumber')
      expect(result).toBe('ok')
    })
  })

  describe('JSON-RPC request format', () => {
    it('should send properly formatted JSON-RPC requests', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('ok'))

      const manager = new RpcManager({ endpoints: ['http://rpc1.test'] })
      await manager.request('eth_getBalance', ['0x1234', 'latest'])

      const [, options] = mockFetch.mock.calls[0]
      const body = JSON.parse(options.body)

      expect(body.jsonrpc).toBe('2.0')
      expect(body.method).toBe('eth_getBalance')
      expect(body.params).toEqual(['0x1234', 'latest'])
      expect(body.id).toBeTypeOf('number')
    })

    it('should send correct content-type header', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('ok'))

      const manager = new RpcManager({ endpoints: ['http://rpc1.test'] })
      await manager.request('eth_blockNumber')

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['Content-Type']).toBe('application/json')
    })
  })

  describe('getEndpoints and getStrategy', () => {
    it('should return a copy of endpoints', () => {
      const endpoints = ['http://rpc1.test', 'http://rpc2.test']
      const manager = new RpcManager({ endpoints })
      const returned = manager.getEndpoints()

      expect(returned).toEqual(endpoints)
      // Should be a copy, not the same reference
      expect(returned).not.toBe(endpoints)
    })

    it('should return the configured strategy', () => {
      const manager = new RpcManager({
        endpoints: ['http://rpc1.test'],
        strategy: 'fastest',
      })
      expect(manager.getStrategy()).toBe('fastest')
    })
  })
})
