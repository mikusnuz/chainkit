export {
  encodeFunctionCall,
  encodeFunctionSelector,
  encodeAddress,
  encodeUint256,
  encodeInt256,
  encodeBytes32,
  encodeString,
  encodeBool,
  encodeBytes,
} from './encoder.js'

export {
  decodeFunctionResult,
  decodeAddress,
  decodeUint256,
  decodeInt256,
  decodeString,
  decodeBool,
  decodeBytes32,
} from './decoder.js'

/**
 * Common ERC-20 function signatures for convenience.
 */
export const ERC20 = {
  transfer: 'transfer(address,uint256)',
  approve: 'approve(address,uint256)',
  balanceOf: 'balanceOf(address)',
  allowance: 'allowance(address,address)',
  totalSupply: 'totalSupply()',
  decimals: 'decimals()',
  symbol: 'symbol()',
  name: 'name()',
} as const
