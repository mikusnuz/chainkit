import { describe, it, expect } from 'vitest'
import { MinaProvider } from '../provider.js'

describe('MinaProvider', () => {
  it('should construct with a string endpoint', () => {
    const provider = new MinaProvider({
      endpoints: 'https://devnet.minaprotocol.network/graphql',
    })
    expect(provider).toBeDefined()
  })

  it('should construct with an array endpoint', () => {
    const provider = new MinaProvider({
      endpoints: ['https://devnet.minaprotocol.network/graphql'],
    })
    expect(provider).toBeDefined()
  })

  it('should construct with a categorized endpoint', () => {
    const provider = new MinaProvider({
      endpoints: {
        rpc: 'https://devnet.minaprotocol.network/graphql',
      },
    })
    expect(provider).toBeDefined()
  })

  it('should return correct fee estimates', async () => {
    const provider = new MinaProvider({
      endpoints: 'https://devnet.minaprotocol.network/graphql',
    })
    const fee = await provider.estimateFee()
    expect(fee.slow).toBe('10000000')
    expect(fee.average).toBe('100000000')
    expect(fee.fast).toBe('500000000')
    expect(fee.unit).toBe('nanomina')
  })
})
