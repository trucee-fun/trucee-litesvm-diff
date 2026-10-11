/**
 * Shared Zero-PvP test fixture: creates a DBC transfer-hook pool + router market on any Chain and
 * exposes instruction builders. Builders accept account overrides so negative tests can substitute
 * accounts (fake pool, foreign buffer, someone else's position, ...).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction,
} from '@solana/web3.js'
import {
  MINT_SIZE, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createMintToInstruction, createSyncNativeInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID, createDbcProgram, deriveDbcEventAuthority,
  deriveDbcPoolAddress, deriveDbcPoolAuthority, deriveDbcTokenVaultAddress, deriveTokenBadgeAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Chain, TxResult } from './chain'

export const HOOK_ID = new PublicKey('CUNNV1MqVB53N4jWn91uVFXm1dBSyaynR6iBCbufJWMS')
export const ROUTER_ID = new PublicKey('D4sk6wwELD6cmd7tv6hE4hkxQP8SF8tjdegYym8iWNNb')
export const ZPVP_DEPLOY = '../zpvp/target/deploy'
export const BASE_DECIMALS = 6
const QUOTE_DECIMALS = 9
const SWAP_MODE_PARTIAL_FILL = 1
const QUOTE_PER_TRADER = 100_000n * 10n ** 9n
// Market layout (borsh): disc 8 | 7 pubkeys | fee u64 | bump u8 | total_basis u64 | finalized u8 | surplus u64 | basis_snapshot u64 | claimed u64
export const MARKET_TOTAL_BASIS_OFFSET = 241
export const MARKET_SURPLUS_SNAPSHOT_OFFSET = 250
export const MARKET_BASIS_SNAPSHOT_OFFSET = 258
export const POOL_MIGRATION_PROGRESS_OFFSET = 308
export const POOL_QUOTE_RESERVE_OFFSET = 240
// ConfigWithTransferHook: PoolConfig fields, swap_base_amount sits right before migration_quote_threshold (264)
export const CONFIG_SWAP_BASE_AMOUNT_OFFSET = 256
export const HOOK_REJECTION = /TransferNotViaRouter|CUNNV1MqVB53N4jWn91uVFXm1dBSyaynR6iBCbufJWMS failed/

export const { program: dbc } = createDbcProgram(new Connection('http://127.0.0.1:1'))
export const eventAuthority = deriveDbcEventAuthority()
export const poolAuthority = deriveDbcPoolAuthority()

export const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
export const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b }
export const pda = (seeds: Buffer[], programId: PublicKey) => PublicKey.findProgramAddressSync(seeds, programId)[0]
export const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isSigner, isWritable })

export function must(r: TxResult, what: string): void {
  if (!r.ok) throw new Error(`${what} failed: ${r.error}`)
}

export function check(cond: boolean, label: string, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!cond) process.exitCode = 1
}

/** Matches a LiteSVM failure where instruction `index` returned Anchor error `code` named `name` (exact code, not a prefix). */
export const anchorError = (code: number, name: string, index = 0) =>
  new RegExp(`index: ${index}, error: InstructionErrorCustom \\{ code: ${code} \\}[\\s\\S]*Error Code: ${name}\\. Error Number: ${code}\\.`)

export type Scenario = {
  seed: number; sqrt_start_price: string; fee_numerator: number; migration_quote_threshold: string
  curve: { sqrt_price: string; liquidity: string }[]
}

export function configParameters(s: Scenario) {
  const zeroVesting = { vestingPercentage: 0, bpsPerPeriod: 0, numberOfPeriods: 0, cliffDurationFromMigrationTime: 0, frequency: 0 }
  return {
    poolFees: { baseFee: { cliffFeeNumerator: new BN(s.fee_numerator), firstFactor: 0, secondFactor: new BN(0), thirdFactor: new BN(0), baseFeeMode: 0 }, dynamicFee: null },
    collectFeeMode: 0, migrationOption: 1, activationType: 0, tokenType: 1, tokenDecimal: BASE_DECIMALS,
    partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100,
    creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0,
    migrationQuoteThreshold: new BN(s.migration_quote_threshold), sqrtStartPrice: new BN(s.sqrt_start_price),
    lockedVesting: { amountPerPeriod: new BN(0), cliffDurationFromMigrationTime: new BN(0), frequency: new BN(0), numberOfPeriod: new BN(0), cliffUnlockAmount: new BN(0) },
    migrationFeeOption: 0, tokenSupply: null, creatorTradingFeePercentage: 0, tokenUpdateAuthority: 1,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 },
    poolCreationFee: new BN(0), partnerLiquidityVestingInfo: zeroVesting, creatorLiquidityVestingInfo: zeroVesting,
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams: { numberOfPeriod: 0, sqrtPriceStepBps: 0, schedulerExpirationDuration: 0, reductionFactor: new BN(0) },
    enableFirstSwapWithMinFee: false, compoundingFeeBps: 0, padding: [0, 0],
    curve: s.curve.map((p) => ({ sqrtPrice: new BN(p.sqrt_price), liquidity: new BN(p.liquidity) })),
  }
}

/**
 * Anti-dump preset for the DAMM v2 pool created at migration (DBC "Customizable" migration):
 * 10% fee while price sits at/below the migration price, -0.45% per ~5% price rise (sqrt step 250 bps)
 * down to 1%, everything expires to 1% after 24h; volatility (dynamic) fee on top. Fees collected in quote.
 */
export const ANTI_DUMP_OVERRIDES = {
  migrationFeeOption: 6,
  migratedPoolFee: { collectFeeMode: 0, dynamicFee: 1, poolFeeBps: 1000 },
  migratedPoolBaseFeeMode: 3, // FeeMarketCapSchedulerLinear
  migratedPoolMarketCapFeeSchedulerParams: {
    numberOfPeriod: 20, sqrtPriceStepBps: 250, schedulerExpirationDuration: 86_400, reductionFactor: new BN(4_500_000),
  },
}

/** A quote mint that already exists on the chain (e.g. a mainnet xStock loaded from a fixture). */
export type QuoteOptions = {
  mint: PublicKey
  tokenProgram: PublicKey
  decimals: number
  /** DBC token badge, required by DBC for Token-2022 quote mints with extensions it does not allow by default. */
  badge?: PublicKey
}

export type FixtureOptions = {
  wsol: boolean
  traderCount: number
  traderLamports: bigint
  /** Optional sink for signatures of setup steps (live runs). */
  signatures?: Record<string, string>
  /** Called with the trader keypairs before they are funded (live runs persist them so funds stay recoverable). */
  onTraders?: (traders: Keypair[]) => void
  /** Reuse an existing quote mint (lets several markets share one quote). */
  quoteMint?: PublicKey
  /** Skip creating the router market (to test init_market itself). */
  skipMarket?: boolean
  /** Shallow overrides merged into the DBC ConfigParameters (fee modes, dynamic fee, ...). */
  configOverrides?: Record<string, unknown>
  /** Transfer hook program written into the DBC config (default zpvp_hook). */
  hookProgram?: PublicKey
  /** Pre-loaded quote mint (not minted to traders: fund them with `setTokenAmount`). Excludes `wsol` / `quoteMint`. */
  quote?: QuoteOptions
}

/** Account overrides for router buy/sell builders. */
export type SwapOverrides = Partial<Record<
  'market' | 'position' | 'userQuote' | 'userBase' | 'buffer' | 'config' | 'pool' | 'baseVault' | 'quoteVault' |
  'baseMint' | 'quoteMint' | 'dbcProgram', PublicKey>> & { hookAccounts?: ReturnType<typeof meta>[] }

export async function createMarketFixture(chain: Chain, admin: Keypair, scenario: Scenario, opts: FixtureOptions) {
  const step = async (what: string, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = []) => {
    const r = await chain.send(payer, ixs, signers)
    must(r, what)
    if (r.ok && r.signature && opts.signatures) opts.signatures[what] = r.signature
  }
  const balanceOf = async (a: PublicKey) => (await chain.accountData(a))?.readBigUInt64LE(64) ?? 0n

  // --- quote: native SOL (wSOL), a shared mint, a pre-loaded mint, or a fresh mint we control
  if (opts.quote) await assertPreloadedQuote(chain, opts)
  const ownQuoteMint = Keypair.generate()
  const quoteMintPk = opts.quote?.mint ?? (opts.wsol ? NATIVE_MINT : opts.quoteMint ?? ownQuoteMint.publicKey)
  const quoteTokenProgram = opts.quote?.tokenProgram ?? TOKEN_PROGRAM_ID
  const badgeAccounts = opts.quote?.badge ? [meta(opts.quote.badge)] : []
  if (!opts.wsol && !opts.quoteMint && !opts.quote) {
    await step('create quote mint', admin, [
      SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: ownQuoteMint.publicKey,
        lamports: await chain.rentExempt(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(ownQuoteMint.publicKey, QUOTE_DECIMALS, admin.publicKey, null),
    ], [ownQuoteMint])
  }

  // --- DBC config + pool with transfer hook = zpvp_hook
  const config = Keypair.generate()
  const hookProgram = opts.hookProgram ?? HOOK_ID
  const params = { ...configParameters(scenario), ...(opts.configOverrides ?? {}) }
  await step('create_config_with_transfer_hook', admin, [await dbc.methods.createConfigWithTransferHook(params as never)
    .accountsPartial({ config: config.publicKey, feeClaimer: admin.publicKey, leftoverReceiver: admin.publicKey,
      quoteMint: quoteMintPk, transferHookProgram: hookProgram, payer: admin.publicKey, eventAuthority })
    .remainingAccounts(badgeAccounts).instruction()], [config])

  const baseMint = Keypair.generate()
  const pool = deriveDbcPoolAddress(quoteMintPk, baseMint.publicKey, config.publicKey)
  const baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey)
  const quoteVault = deriveDbcTokenVaultAddress(pool, quoteMintPk)
  await step('initialize pool with hook', admin, [await dbc.methods.initializeVirtualPoolWithToken2022TransferHook({ name: 'ZeroPvP', symbol: 'ZPVP', uri: 'https://x.y' })
    .accountsPartial({ config: config.publicKey, poolAuthority, creator: admin.publicKey, baseMint: baseMint.publicKey,
      quoteMint: quoteMintPk, pool, baseVault, quoteVault, transferHookProgram: hookProgram, payer: admin.publicKey,
      tokenQuoteProgram: quoteTokenProgram, tokenProgram: TOKEN_2022_PROGRAM_ID, eventAuthority })
    .remainingAccounts(badgeAccounts).instruction()], [baseMint])

  // --- hook extra-account-metas + router market
  const extraMetas = pda([Buffer.from('extra-account-metas'), baseMint.publicKey.toBuffer()], HOOK_ID)
  if (hookProgram.equals(HOOK_ID)) await step('hook: init extra metas', admin, [new TransactionInstruction({ programId: HOOK_ID, data: disc('initialize_extra_account_meta_list'),
    keys: [meta(admin.publicKey, true, true), meta(extraMetas, true), meta(baseMint.publicKey), meta(SystemProgram.programId)] })])

  const market = pda([Buffer.from('market'), pool.toBuffer()], ROUTER_ID)
  const buffer = pda([Buffer.from('buffer'), market.toBuffer()], ROUTER_ID)
  const initMarketIx = (o: { pool?: PublicKey; config?: PublicKey; quoteMint?: PublicKey } = {}) => {
    const p = o.pool ?? pool
    const m = pda([Buffer.from('market'), p.toBuffer()], ROUTER_ID)
    return new TransactionInstruction({ programId: ROUTER_ID, data: disc('init_market'),
      keys: [meta(admin.publicKey, true, true), meta(p), meta(o.config ?? config.publicKey), meta(o.quoteMint ?? quoteMintPk),
        meta(m, true), meta(pda([Buffer.from('buffer'), m.toBuffer()], ROUTER_ID), true), meta(quoteTokenProgram), meta(SystemProgram.programId)] })
  }
  if (!opts.skipMarket) await step('router: init market', admin, [initMarketIx()])

  const hookAccounts = [meta(extraMetas), meta(SYSVAR_INSTRUCTIONS_PUBKEY), meta(HOOK_ID)]

  // --- traders
  const traders = Array.from({ length: opts.traderCount }, () => Keypair.generate())
  opts.onTraders?.(traders)
  const ata = traders.map((t) => ({
    quote: getAssociatedTokenAddressSync(quoteMintPk, t.publicKey, false, quoteTokenProgram),
    base: getAssociatedTokenAddressSync(baseMint.publicKey, t.publicKey, false, TOKEN_2022_PROGRAM_ID),
  }))
  for (const [i, t] of traders.entries()) {
    await chain.fund(t.publicKey, opts.traderLamports)
    await step(`trader ${i} setup`, admin, [
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata[i].quote, t.publicKey, quoteMintPk, quoteTokenProgram),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata[i].base, t.publicKey, baseMint.publicKey, TOKEN_2022_PROGRAM_ID),
      ...(opts.wsol || opts.quote ? [] : [createMintToInstruction(quoteMintPk, ata[i].quote, admin.publicKey, QUOTE_PER_TRADER)]),
    ])
  }

  const positionOf = (i: number) => pda([Buffer.from('position'), market.toBuffer(), traders[i].publicKey.toBuffer()], ROUTER_ID)
  const readPosition = async (i: number) => {
    const d = await chain.accountData(positionOf(i))
    return d ? { tokens: d.readBigUInt64LE(72), basis: d.readBigUInt64LE(80) } : { tokens: 0n, basis: 0n }
  }
  const routerIx = (i: number, name: 'buy' | 'sell', args: Buffer, o: SwapOverrides = {}) => new TransactionInstruction({
    programId: ROUTER_ID, data: Buffer.concat([disc(name), args]), keys: [
      meta(traders[i].publicKey, true, true), meta(o.market ?? market, true), meta(o.position ?? positionOf(i), true),
      meta(o.userQuote ?? ata[i].quote, true), meta(o.userBase ?? ata[i].base, true), meta(o.buffer ?? buffer, true),
      meta(poolAuthority), meta(o.config ?? config.publicKey), meta(o.pool ?? pool, true), meta(o.baseVault ?? baseVault, true),
      meta(o.quoteVault ?? quoteVault, true), meta(o.baseMint ?? baseMint.publicKey, true), meta(o.quoteMint ?? quoteMintPk),
      meta(TOKEN_2022_PROGRAM_ID), meta(quoteTokenProgram), meta(eventAuthority), meta(o.dbcProgram ?? DYNAMIC_BONDING_CURVE_PROGRAM_ID),
      meta(SystemProgram.programId), ...(o.hookAccounts ?? hookAccounts),
    ] })
  // wSOL: wrap exactly amount_in in the same transaction (separate top-level instructions; the hook only
  // inspects the instruction that performs the base-token transfer)
  const wrapIxs = (i: number, amount: bigint) => (opts.wsol ? [
    SystemProgram.transfer({ fromPubkey: traders[i].publicKey, toPubkey: ata[i].quote, lamports: amount }),
    createSyncNativeInstruction(ata[i].quote),
  ] : [])
  /** `wrap` (wSOL only): native SOL to wrap first; defaults to the full amount_in. */
  const buyIxs = (i: number, amount: bigint, o: SwapOverrides = {}, wrap = amount) =>
    [...(wrap > 0n ? wrapIxs(i, wrap) : []), routerIx(i, 'buy', Buffer.concat([u64(amount), u64(0n)]), o)]
  const sellIx = (i: number, tokens: bigint, o: SwapOverrides = {}) => routerIx(i, 'sell', u64(tokens), o)
  const directDbcBuyIxs = async (i: number, amount: bigint) => [
    ...wrapIxs(i, amount),
    await dbc.methods.swap2WithTransferHook(
      { amount0: new BN(amount.toString()), amount1: new BN(0), swapMode: SWAP_MODE_PARTIAL_FILL },
      { slices: [{ accountsType: { transferHookBase: {} }, length: 3 }] },
    ).accountsPartial({ poolAuthority, config: config.publicKey, pool, inputTokenAccount: ata[i].quote, outputTokenAccount: ata[i].base,
      baseVault, quoteVault, baseMint: baseMint.publicKey, quoteMint: quoteMintPk, payer: traders[i].publicKey,
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: quoteTokenProgram, referralTokenAccount: null, eventAuthority })
      .remainingAccounts(hookAccounts).instruction(),
  ]
  const transferIx = (from: number, to: number, amount: bigint, withHookAccounts: boolean, authority?: PublicKey) => {
    const ix = createTransferCheckedInstruction(ata[from].base, baseMint.publicKey, ata[to].base,
      authority ?? traders[from].publicKey, amount, BASE_DECIMALS, [], TOKEN_2022_PROGRAM_ID)
    if (withHookAccounts) ix.keys.push(meta(SYSVAR_INSTRUCTIONS_PUBKEY), meta(HOOK_ID), meta(extraMetas))
    return ix
  }
  const finalizeIx = (o: { market?: PublicKey; pool?: PublicKey; buffer?: PublicKey } = {}) => new TransactionInstruction({
    programId: ROUTER_ID, data: disc('finalize'), keys: [meta(o.market ?? market, true), meta(o.pool ?? pool), meta(o.buffer ?? buffer)] })
  /** claim_surplus for trader `owner`'s position; `cranker` may be anyone (the owner or a third party). */
  const claimIx = (cranker: PublicKey, owner: number,
    o: { buffer?: PublicKey; ownerQuote?: PublicKey; owner?: PublicKey; position?: PublicKey } = {}) => new TransactionInstruction({
    programId: ROUTER_ID, data: disc('claim_surplus'),
    keys: [meta(cranker, false, true), meta(o.owner ?? traders[owner].publicKey, true), meta(market, true),
      meta(o.position ?? positionOf(owner), true), meta(o.ownerQuote ?? ata[owner].quote, true), meta(o.buffer ?? buffer, true),
      meta(quoteMintPk), meta(quoteTokenProgram)] })
  const curveDone = async () => ((await chain.accountData(pool))![POOL_MIGRATION_PROGRESS_OFFSET]) !== 0

  return {
    chain, admin, quoteMintPk, quoteTokenProgram, config, baseMint, pool, baseVault, quoteVault, extraMetas, market, buffer, hookAccounts,
    traders, ata, positionOf, readPosition, balanceOf, initMarketIx, buyIxs, sellIx, directDbcBuyIxs, transferIx,
    finalizeIx, claimIx, curveDone, step,
  }
}

export type MarketFixture = Awaited<ReturnType<typeof createMarketFixture>>

// --- pre-loaded quote mints (mainnet xStocks on LiteSVM)

export const MAINNET_FIXTURE_DIR = 'fixtures/mainnet'
const XSTOCK_DECIMALS = 8
/** Allowlisted xStock quote mints (zpvp_router QUOTE_CAPS), both Token-2022 with 8 decimals. */
export const XSTOCKS = {
  TSLAx: new PublicKey('XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'),
  NVDAx: new PublicKey('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'),
} as const
export type XStock = keyof typeof XSTOCKS

const MINT_DECIMALS_OFFSET = 44
const MINT_INITIALIZED_OFFSET = 45
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const TOKEN_ACCOUNT_BASE_LEN = 165
const U64_MAX = 2n ** 64n - 1n

type AccountFixture = { address: string; owner: string; lamports: number; executable: boolean; data: string }

function parseAccountFixture(raw: unknown, path: string): AccountFixture {
  const f = raw as Partial<AccountFixture> | null
  const valid = !!f && typeof f.address === 'string' && typeof f.owner === 'string' && typeof f.data === 'string' &&
    typeof f.executable === 'boolean' && Number.isSafeInteger(f.lamports) && (f.lamports as number) >= 0
  if (!valid) throw new Error(`${path}: expected {address, owner, lamports, executable, data(base64)}`)
  return f as AccountFixture
}

/** Writes a mainnet account snapshot (`<dir>/<address>.json`) into a chain that supports `setAccount`. */
export function loadAccountFixture(chain: Chain, address: PublicKey, dir = MAINNET_FIXTURE_DIR): void {
  if (!chain.setAccount) throw new Error(`${chain.name}: cannot load account fixtures (LiteSVM only)`)
  const path = `${dir}/${address.toBase58()}.json`
  const fixture = parseAccountFixture(JSON.parse(readFileSync(path, 'utf8')), path)
  if (fixture.address !== address.toBase58()) throw new Error(`${path}: address is ${fixture.address}`)
  chain.setAccount(address, {
    lamports: BigInt(fixture.lamports), owner: new PublicKey(fixture.owner), executable: fixture.executable,
    data: Buffer.from(fixture.data, 'base64'),
  })
}

/** Loads an xStock mint and its DBC token badge from mainnet fixtures; returns the fixture `quote` option. */
export function loadXStockQuote(chain: Chain, name: XStock): QuoteOptions {
  const mint = XSTOCKS[name]
  const badge = deriveTokenBadgeAddress(mint)
  loadAccountFixture(chain, mint)
  loadAccountFixture(chain, badge)
  return { mint, tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: XSTOCK_DECIMALS, badge }
}

/**
 * Sets a token account's raw balance (u64 at byte 64) without minting: we do not hold mainnet mint authorities.
 * `tokenProgram` must be the program that owns the account.
 */
export async function setTokenAmount(chain: Chain, tokenAccount: PublicKey, tokenProgram: PublicKey, amount: bigint): Promise<void> {
  if (!chain.setAccount) throw new Error(`${chain.name}: cannot set token balances (LiteSVM only)`)
  if (amount < 0n || amount > U64_MAX) throw new Error(`token amount ${amount} is not a u64`)
  const data = await chain.accountData(tokenAccount)
  if (!data || data.length < TOKEN_ACCOUNT_BASE_LEN) throw new Error(`token account ${tokenAccount.toBase58()} does not exist`)
  const next = Buffer.from(data)
  next.writeBigUInt64LE(amount, TOKEN_ACCOUNT_AMOUNT_OFFSET)
  chain.setAccount(tokenAccount, { lamports: await chain.lamports(tokenAccount), owner: tokenProgram, executable: false, data: next })
}

async function assertPreloadedQuote(chain: Chain, opts: FixtureOptions): Promise<void> {
  const quote = opts.quote!
  if (opts.wsol || opts.quoteMint) throw new Error('fixture: `quote` cannot be combined with `wsol` or `quoteMint`')
  if (!Number.isInteger(quote.decimals) || quote.decimals < 0 || quote.decimals > 255) throw new Error(`fixture: bad quote decimals ${quote.decimals}`)
  const mint = await chain.accountData(quote.mint)
  if (!mint || mint.length < MINT_SIZE || mint[MINT_INITIALIZED_OFFSET] !== 1) {
    throw new Error(`fixture: quote mint ${quote.mint.toBase58()} is not on ${chain.name} (load it first)`)
  }
  if (mint[MINT_DECIMALS_OFFSET] !== quote.decimals) {
    throw new Error(`fixture: quote mint has ${mint[MINT_DECIMALS_OFFSET]} decimals, expected ${quote.decimals}`)
  }
  if (quote.badge && !(await chain.accountData(quote.badge))) throw new Error(`fixture: token badge ${quote.badge.toBase58()} is not on ${chain.name}`)
}
