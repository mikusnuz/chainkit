/**
 * An EOSIO action within a transaction.
 */
export interface EosAction {
  /** Contract account name (e.g., "eosio.token") */
  account: string
  /** Action name (e.g., "transfer") */
  name: string
  /** Authorization array */
  authorization: Array<{ actor: string; permission: string }>
  /** Action data (ABI-encoded hex or structured object) */
  data: unknown
}

/**
 * EOS transaction data structure.
 * EOSIO transactions contain a list of actions rather than a single transfer.
 */
export interface EosTransactionData {
  /** Array of actions to execute */
  actions: EosAction[]
  /** Expiration time (ISO string or seconds from now) */
  expiration?: string
  /** Reference block number */
  refBlockNum?: number
  /** Reference block prefix */
  refBlockPrefix?: number
  /** Max CPU usage in microseconds (0 = no limit) */
  maxCpuUsageMs?: number
  /** Max NET usage in words (0 = no limit) */
  maxNetUsageWords?: number
  /** Delay in seconds */
  delaySec?: number
}

/**
 * EOS fee/resource detail.
 * EOS uses a resource model (CPU/NET/RAM) instead of gas fees.
 */
export interface EosFeeDetail {
  /** CPU usage in microseconds */
  cpuUsage: number
  /** NET usage in bytes */
  netUsage: number
  /** RAM usage in bytes */
  ramBytes: number
}

/**
 * EOSIO chain info response from /v1/chain/get_info.
 */
export interface EosChainInfoResponse {
  server_version: string
  chain_id: string
  head_block_num: number
  last_irreversible_block_num: number
  head_block_id: string
  head_block_time: string
  head_block_producer: string
  virtual_block_cpu_limit: number
  virtual_block_net_limit: number
  block_cpu_limit: number
  block_net_limit: number
}

/**
 * EOSIO account info response from /v1/chain/get_account.
 */
export interface EosAccountResponse {
  account_name: string
  core_liquid_balance?: string
  ram_quota: number
  ram_usage: number
  net_weight: number
  cpu_weight: number
  net_limit: { used: number; available: number; max: number; last_usage_update_time?: string; current_used?: number }
  cpu_limit: { used: number; available: number; max: number; last_usage_update_time?: string; current_used?: number }
  permissions: Array<{
    perm_name: string
    parent: string
    required_auth: {
      threshold: number
      keys: Array<{ key: string; weight: number }>
      accounts: Array<{ permission: { actor: string; permission: string }; weight: number }>
    }
  }>
  total_resources?: {
    owner: string
    net_weight: string
    cpu_weight: string
    ram_bytes: number
  }
  created: string
  head_block_num: number
  head_block_time: string
}

/**
 * EOSIO block response from /v1/chain/get_block.
 */
export interface EosBlockResponse {
  id: string
  block_num: number
  previous: string
  timestamp: string
  producer: string
  confirmed: number
  transaction_mroot: string
  action_mroot: string
  transactions: Array<{
    status: string
    cpu_usage_us: number
    net_usage_words: number
    trx: string | { id: string; signatures: string[]; packed_trx: string }
  }>
}

/**
 * EOSIO currency balance response.
 */
export interface EosCurrencyBalance {
  /** Balance string like "100.0000 EOS" */
  balance: string
}

/**
 * EOSIO currency stats response.
 */
export interface EosCurrencyStats {
  [symbol: string]: {
    supply: string
    max_supply: string
    issuer: string
  }
}

/**
 * EOSIO table rows response.
 */
export interface EosTableRowsResponse<T = unknown> {
  rows: T[]
  more: boolean
  next_key?: string
}
