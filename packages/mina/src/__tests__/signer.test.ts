import { describe, it, expect } from 'vitest'
import { MinaSigner } from '../signer.js'
import { poseidonHash, poseidonLegacyHash } from '../poseidon.js'

const TEST_MNEMONIC =
  'birth bacon antenna hurry eagle exclude hunt globe arctic clinic trash lens ridge about disease debris fine throw chef entire still erase law elder'

const MINA_HD_PATH = "m/44'/12586'/0'/0/0"

// Helper: convert little-endian hex to bigint field element
function hexToField(hex: string): bigint {
  const bytes = Buffer.from(hex, 'hex')
  let val = 0n
  for (let i = 0; i < bytes.length; i++) {
    val += BigInt(bytes[i]) << BigInt(8 * i)
  }
  return val
}

function fieldToHex(field: bigint): string {
  let hex = ''
  let val = field
  for (let i = 0; i < 32; i++) {
    const byte = Number(val & 0xffn)
    hex += byte.toString(16).padStart(2, '0')
    val >>= 8n
  }
  return hex
}

describe('Poseidon Kimchi (o1js test vectors)', () => {
  it('should hash empty input correctly', () => {
    expect(fieldToHex(poseidonHash([]))).toBe(
      'a8eb9ee0f30046308abbfa5d20af73c81bbdabc25b459785024d045228bead2f',
    )
  })

  it('should hash single field element correctly', () => {
    const input = [hexToField('f2eee8d8f6e5fb182c610cae6c5393fce69dc4d900e7b4923b074e54ad00fb36')]
    expect(fieldToHex(poseidonHash(input))).toBe(
      'fb5992f65c07f9335995f43fd791d39012ad466717729e61045c297507054f3d',
    )
  })

  it('should hash two field elements correctly', () => {
    const input = [
      hexToField('bd3f1c8f183ceedea15080edbe79d30bd7d613b86bf2ba12007091c60ae39337'),
      hexToField('65e4f04ab87706bab06d13c7eee0a7807d0b8ce268b4ece6aab1e0508ec9c42f'),
    ]
    expect(fieldToHex(poseidonHash(input))).toBe(
      'fe2436f2027620a11233318b55d0a117086f09674826d1b7ce08d48ad0736c33',
    )
  })
})

describe('Poseidon Legacy (o1js test vectors)', () => {
  it('should hash empty input correctly', () => {
    expect(fieldToHex(poseidonLegacyHash([]))).toBe(
      '1b3251b6912d82edc78bbb0a5c88f0c6fde1781bc3e654123fa6862a4c63e617',
    )
  })

  it('should hash single field element correctly', () => {
    const input = [hexToField('f2eee8d8f6e5fb182c610cae6c5393fce69dc4d900e7b4923b074e54ad00fb36')]
    expect(fieldToHex(poseidonLegacyHash(input))).toBe(
      'e99262048e717745fdcd602a3b527e9e7c2e5ba5894158084e2f2e2cb142643d',
    )
  })

  it('should hash two field elements correctly', () => {
    const input = [
      hexToField('bd3f1c8f183ceedea15080edbe79d30bd7d613b86bf2ba12007091c60ae39337'),
      hexToField('65e4f04ab87706bab06d13c7eee0a7807d0b8ce268b4ece6aab1e0508ec9c42f'),
    ]
    expect(fieldToHex(poseidonLegacyHash(input))).toBe(
      '1f8f9d2fb9547d0254a1c0271ff40042a59927e82fd097d7fa723f8551e8c23a',
    )
  })

  it('should hash five field elements correctly', () => {
    const input = [
      hexToField('da99182b35f2cd9f8a137052c4262576377a16deb83652db459a74893a0cf73c'),
      hexToField('9805573990c4028292c9db171cd2b97902f9fc494983f6f7e0a0c184bc55df1b'),
      hexToField('90ff1001b9dab21358aad1f6b7906a56d0c039502c1590c3ef9921a8951e4409'),
      hexToField('88b56238a0eda34576db959fecd1c3790bb5311fdb231753243c5085974a5b37'),
      hexToField('896a7727e511a4c30d99082bf3542623fb702afab0b62ebbf301ed51e38f6812'),
    ]
    expect(fieldToHex(poseidonLegacyHash(input))).toBe(
      '461b6ec08fd3a9c37033efd409cf548493b003b2f500db845d5d1fd2ffce1b02',
    )
  })
})

describe('MinaSigner', () => {
  const signer = new MinaSigner()

  describe('generateMnemonic', () => {
    it('should generate a valid 12-word mnemonic', () => {
      const mnemonic = signer.generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(12)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate a valid 24-word mnemonic with strength 256', () => {
      const mnemonic = signer.generateMnemonic(256)
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(24)
      expect(signer.validateMnemonic(mnemonic)).toBe(true)
    })
  })

  describe('validateMnemonic', () => {
    it('should validate a correct mnemonic', () => {
      expect(signer.validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject an invalid mnemonic', () => {
      expect(signer.validateMnemonic('invalid mnemonic words')).toBe(false)
    })
  })

  describe('derivePrivateKey', () => {
    it('should derive a private key from mnemonic', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      expect(pk).toBeDefined()
      expect(typeof pk).toBe('string')
      expect(pk.length).toBe(64) // 32 bytes hex
    })

    it('should derive the same key deterministically', async () => {
      const pk1 = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const pk2 = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      expect(pk1).toBe(pk2)
    })
  })

  describe('getAddress', () => {
    it('should derive a B62 address from private key', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const address = signer.getAddress(pk)
      expect(address).toBeDefined()
      expect(address.startsWith('B62')).toBe(true)
    })

    it('should derive the same address deterministically', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const addr1 = signer.getAddress(pk)
      const addr2 = signer.getAddress(pk)
      expect(addr1).toBe(addr2)
    })

    it('should throw on invalid private key length', () => {
      expect(() => signer.getAddress('abcd')).toThrow()
    })
  })

  describe('validateAddress', () => {
    it('should validate a derived address', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const address = signer.getAddress(pk)
      expect(signer.validateAddress(address)).toBe(true)
    })

    it('should reject addresses without B62 prefix', () => {
      expect(signer.validateAddress('0x1234567890abcdef')).toBe(false)
    })

    it('should reject empty string', () => {
      expect(signer.validateAddress('')).toBe(false)
    })

    it('should reject random invalid B62 string', () => {
      expect(signer.validateAddress('B62abc')).toBe(false)
    })
  })

  describe('signMessage', () => {
    it('should sign a message and return JSON with field and scalar', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const result = await signer.signMessage({ privateKey: pk, message: 'Hello Mina' })
      const parsed = JSON.parse(result)
      expect(parsed.field).toBeDefined()
      expect(parsed.scalar).toBeDefined()
      expect(typeof parsed.field).toBe('string')
      expect(typeof parsed.scalar).toBe('string')
    })

    it('should produce deterministic signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: pk, message: 'Hello Mina' })
      const sig2 = await signer.signMessage({ privateKey: pk, message: 'Hello Mina' })
      expect(sig1).toBe(sig2)
    })

    it('should produce different signatures for different messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const sig1 = await signer.signMessage({ privateKey: pk, message: 'Hello' })
      const sig2 = await signer.signMessage({ privateKey: pk, message: 'World' })
      expect(sig1).not.toBe(sig2)
    })

    it('should sign Uint8Array messages', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const msg = new TextEncoder().encode('Hello Mina')
      const result = await signer.signMessage({ privateKey: pk, message: msg })
      const parsed = JSON.parse(result)
      expect(parsed.field).toBeDefined()
      expect(parsed.scalar).toBeDefined()
    })
  })

  describe('signTransaction', () => {
    it('should sign a payment transaction', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const address = signer.getAddress(pk)

      const result = await signer.signTransaction({
        privateKey: pk,
        tx: {
          from: address,
          to: 'B62qjsV6WQwTeEWrNrRRBP6VaaLvQhwWTnFi4WP4LQjGvpfZEumXzx',
          value: '1000000000',
          fee: { fee: '10000000' },
          nonce: 0,
          memo: 'test payment',
        },
      })

      const parsed = JSON.parse(result)
      expect(parsed.signature).toBeDefined()
      expect(parsed.signature.field).toBeDefined()
      expect(parsed.signature.scalar).toBeDefined()
      expect(parsed.payment).toBeDefined()
      expect(parsed.payment.from).toBe(address)
      expect(parsed.payment.to).toBe('B62qjsV6WQwTeEWrNrRRBP6VaaLvQhwWTnFi4WP4LQjGvpfZEumXzx')
      expect(parsed.payment.amount).toBe('1000000000')
    })

    it('should produce deterministic transaction signatures', async () => {
      const pk = await signer.derivePrivateKey(TEST_MNEMONIC, MINA_HD_PATH)
      const address = signer.getAddress(pk)
      const txParams = {
        privateKey: pk,
        tx: {
          from: address,
          to: 'B62qjsV6WQwTeEWrNrRRBP6VaaLvQhwWTnFi4WP4LQjGvpfZEumXzx',
          value: '1000000000',
          fee: { fee: '10000000' },
          nonce: 0,
        },
      }

      const sig1 = await signer.signTransaction(txParams)
      const sig2 = await signer.signTransaction(txParams)
      expect(sig1).toBe(sig2)
    })
  })
})
