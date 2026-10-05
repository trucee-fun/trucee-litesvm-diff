/**
 * Shared Zero-PvP test fixture: creates a DBC transfer-hook pool + router market on any Chain and
 * exposes instruction builders. Builders accept account overrides so negative tests can substitute
 * accounts (fake pool, foreign buffer, someone else's position, ...).
 */
import { createHash } from 'node:crypto'
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
  deriveDbcPoolAddress, deriveDbcPoolAuthority, deriveDbcTokenVaultAddress,
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

  // --- quote: native SOL (wSOL), a shared mint, or a fresh mint we control
  const ownQuoteMint = Keypair.generate()
  const quoteMintPk = opts.wsol ? NATIVE_MINT : opts.quoteMint ?? ownQuoteMint.publicKey
  if (!opts.wsol && !opts.quoteMint) {
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
      quoteMint: quoteMintPk, transferHookProgram: hookProgram, payer: admin.publicKey, eventAuthority }).instruction()], [config])

  const baseMint = Keypair.generate()
  const pool = deriveDbcPoolAddress(quoteMintPk, baseMint.publicKey, config.publicKey)
  const baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey)
  const quoteVault = deriveDbcTokenVaultAddress(pool, quoteMintPk)
  await step('initialize pool with hook', admin, [await dbc.methods.initializeVirtualPoolWithToken2022TransferHook({ name: 'ZeroPvP', symbol: 'ZPVP', uri: 'https://x.y' })
    .accountsPartial({ config: config.publicKey, poolAuthority, creator: admin.publicKey, baseMint: baseMint.publicKey,
      quoteMint: quoteMintPk, pool, baseVault, quoteVault, transferHookProgram: hookProgram, payer: admin.publicKey,
      tokenQuoteProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_2022_PROGRAM_ID, eventAuthority }).instruction()], [baseMint])

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
        meta(m, true), meta(pda([Buffer.from('buffer'), m.toBuffer()], ROUTER_ID), true), meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId)] })
  }
  if (!opts.skipMarket) await step('router: init market', admin, [initMarketIx()])

  const hookAccounts = [meta(extraMetas), meta(SYSVAR_INSTRUCTIONS_PUBKEY), meta(HOOK_ID)]

  // --- traders
  const traders = Array.from({ length: opts.traderCount }, () => Keypair.generate())
  opts.onTraders?.(traders)
  const ata = traders.map((t) => ({
    quote: getAssociatedTokenAddressSync(quoteMintPk, t.publicKey, false, TOKEN_PROGRAM_ID),
    base: getAssociatedTokenAddressSync(baseMint.publicKey, t.publicKey, false, TOKEN_2022_PROGRAM_ID),
  }))
  for (const [i, t] of traders.entries()) {
    await chain.fund(t.publicKey, opts.traderLamports)
    await step(`trader ${i} setup`, admin, [
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata[i].quote, t.publicKey, quoteMintPk, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata[i].base, t.publicKey, baseMint.publicKey, TOKEN_2022_PROGRAM_ID),
      ...(opts.wsol ? [] : [createMintToInstruction(quoteMintPk, ata[i].quote, admin.publicKey, QUOTE_PER_TRADER)]),
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
      meta(TOKEN_2022_PROGRAM_ID), meta(TOKEN_PROGRAM_ID), meta(eventAuthority), meta(o.dbcProgram ?? DYNAMIC_BONDING_CURVE_PROGRAM_ID),
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
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, eventAuthority })
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
      meta(quoteMintPk), meta(TOKEN_PROGRAM_ID)] })
  const curveDone = async () => ((await chain.accountData(pool))![POOL_MIGRATION_PROGRESS_OFFSET]) !== 0

  return {
    chain, admin, quoteMintPk, config, baseMint, pool, baseVault, quoteVault, extraMetas, market, buffer, hookAccounts,
    traders, ata, positionOf, readPosition, balanceOf, initMarketIx, buyIxs, sellIx, directDbcBuyIxs, transferIx,
    finalizeIx, claimIx, curveDone, step,
  }
}

export type MarketFixture = Awaited<ReturnType<typeof createMarketFixture>>
