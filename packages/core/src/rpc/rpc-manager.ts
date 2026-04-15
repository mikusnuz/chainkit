import { ChainKitError, ErrorCode } from '../types/errors.js'

/**
 * Strategy for selecting RPC endpoints.
 */
export type RpcStrategy = 'failover' | 'round-robin' | 'fastest'

/**
 * Configuration for the RPC manager.
 */
export interface RpcManagerConfig {
  /** List of RPC endpoint URLs */
  endpoints: string[]
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number
  /** Number of retries per endpoint (default: 2) */
  retries?: number
  /** Endpoint selection strategy (default: 'failover') */
  strategy?: RpcStrategy
}

/**
 * A JSON-RPC request object.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown[] | Record<string, unknown>
}

/**
 * A JSON-RPC response object.
 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id: number | string
  result?: T
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

/**
 * Manages multiple RPC endpoints with failover, round-robin, and fastest strategies.
 */
export class RpcManager {
  private readonly endpoints: string[]
  private readonly timeout: number
  private readonly retries: number
  private readonly strategy: RpcStrategy
  private roundRobinIndex = 0
  private requestId = 0

  constructor(config: RpcManagerConfig) {
    if (!config.endpoints || config.endpoints.length === 0) {
      throw new ChainKitError(ErrorCode.INVALID_PARAMS, 'At least one RPC endpoint is required')
    }

    this.endpoints = [...config.endpoints]
    this.timeout = config.timeout ?? 10000
    this.retries = config.retries ?? 2
    this.strategy = config.strategy ?? 'failover'
  }

  /**
   * Send a JSON-RPC request using the configured strategy.
   */
  async request<T = unknown>(method: string, params?: unknown[]): Promise<T> {
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params,
    }

    switch (this.strategy) {
      case 'failover':
        return this.executeFailover<T>(rpcRequest)
      case 'round-robin':
        return this.executeRoundRobin<T>(rpcRequest)
      case 'fastest':
        return this.executeFastest<T>(rpcRequest)
      default:
        throw new ChainKitError(ErrorCode.INVALID_PARAMS, `Unknown strategy: ${this.strategy}`)
    }
  }

  /**
   * Failover strategy: try endpoints in order, fall back on failure.
   */
  private async executeFailover<T>(rpcRequest: JsonRpcRequest): Promise<T> {
    const errors: Error[] = []

    for (const endpoint of this.endpoints) {
      try {
        return await this.sendWithRetries<T>(endpoint, rpcRequest)
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
        // If it's a JSON-RPC error (not a network error), don't try other endpoints
        if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
          throw err
        }
      }
    }

    throw new ChainKitError(ErrorCode.RPC_ALL_FAILED, 'All RPC endpoints failed', {
      errors: errors.map((e) => e.message),
    })
  }

  /**
   * Round-robin strategy: distribute requests across endpoints, fall back on failure.
   */
  private async executeRoundRobin<T>(rpcRequest: JsonRpcRequest): Promise<T> {
    const errors: Error[] = []
    const startIndex = this.roundRobinIndex
    this.roundRobinIndex = (this.roundRobinIndex + 1) % this.endpoints.length

    // Try starting from the round-robin index, wrapping around
    for (let i = 0; i < this.endpoints.length; i++) {
      const index = (startIndex + i) % this.endpoints.length
      const endpoint = this.endpoints[index]
      try {
        return await this.sendWithRetries<T>(endpoint, rpcRequest)
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
        if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
          throw err
        }
      }
    }

    throw new ChainKitError(ErrorCode.RPC_ALL_FAILED, 'All RPC endpoints failed', {
      errors: errors.map((e) => e.message),
    })
  }

  /**
   * Fastest strategy: race all endpoints, return the first successful response.
   */
  private async executeFastest<T>(rpcRequest: JsonRpcRequest): Promise<T> {
    if (this.endpoints.length === 1) {
      return this.sendWithRetries<T>(this.endpoints[0], rpcRequest)
    }

    const controllers: AbortController[] = []

    try {
      const result = await new Promise<T>((resolve, reject) => {
        let completed = false
        let failCount = 0
        const errors: Error[] = []

        for (const endpoint of this.endpoints) {
          const controller = new AbortController()
          controllers.push(controller)

          this.sendSingle<T>(endpoint, rpcRequest, controller.signal)
            .then((result) => {
              if (!completed) {
                completed = true
                resolve(result)
                // Abort all other requests
                for (const c of controllers) {
                  try {
                    c.abort()
                  } catch {
                    // ignore abort errors
                  }
                }
              }
            })
            .catch((err) => {
              if (!completed) {
                errors.push(err instanceof Error ? err : new Error(String(err)))
                // If it's a definitive JSON-RPC error, propagate immediately
                if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
                  completed = true
                  reject(err)
                  for (const c of controllers) {
                    try {
                      c.abort()
                    } catch {
                      // ignore
                    }
                  }
                  return
                }
                failCount++
                if (failCount === this.endpoints.length) {
                  reject(
                    new ChainKitError(ErrorCode.RPC_ALL_FAILED, 'All RPC endpoints failed', {
                      errors: errors.map((e) => e.message),
                    }),
                  )
                }
              }
            })
        }
      })

      return result
    } finally {
      // Clean up any remaining controllers
      for (const c of controllers) {
        try {
          c.abort()
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Send a request with retries to a single endpoint.
   */
  private async sendWithRetries<T>(endpoint: string, rpcRequest: JsonRpcRequest): Promise<T> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController()
        return await this.sendSingle<T>(endpoint, rpcRequest, controller.signal)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        // Don't retry on JSON-RPC errors (they are definitive)
        if (err instanceof ChainKitError && err.code === ErrorCode.RPC_ERROR) {
          throw err
        }
      }
    }

    throw lastError!
  }

  /**
   * Send a single request to an endpoint with timeout.
   */
  private async sendSingle<T>(
    endpoint: string,
    rpcRequest: JsonRpcRequest,
    signal: AbortSignal,
  ): Promise<T> {
    const timeoutId = setTimeout(() => {
      // We need a separate AbortController for timeout since the signal may come from outside
    }, this.timeout)

    const controller = new AbortController()

    // Link the external signal to our controller
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcRequest),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new ChainKitError(ErrorCode.NETWORK_ERROR, `HTTP ${response.status}: ${response.statusText}`, {
          endpoint,
          status: response.status,
        })
      }

      const json = (await response.json()) as JsonRpcResponse<T>

      if (json.error) {
        throw new ChainKitError(ErrorCode.RPC_ERROR, json.error.message, {
          endpoint,
          rpcCode: json.error.code,
          rpcData: json.error.data,
        })
      }

      return json.result as T
    } catch (err) {
      if (err instanceof ChainKitError) {
        throw err
      }
      if (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) {
        throw new ChainKitError(ErrorCode.TIMEOUT, `Request to ${endpoint} timed out`, {
          endpoint,
          timeout: this.timeout,
        })
      }
      throw new ChainKitError(ErrorCode.NETWORK_ERROR, `Request to ${endpoint} failed: ${(err as Error).message}`, {
        endpoint,
      })
    } finally {
      clearTimeout(timer)
      clearTimeout(timeoutId)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Get the list of configured endpoints.
   */
  getEndpoints(): string[] {
    return [...this.endpoints]
  }

  /**
   * Get the current strategy.
   */
  getStrategy(): RpcStrategy {
    return this.strategy
  }
}
