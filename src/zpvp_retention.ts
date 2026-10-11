/**
 * Retention Fee opt-in (ONC-15) on LiteSVM. A DBC config whose `fee_claimer` (@40) is the router's fee authority PDA
 * [b"fees", config] opens a retention market (Market.retention @282 = 1), but only for the retention preset: no creator
 * trading fee (@245), no partner LP at all (unlocked @240, permanently locked @239, vesting @185), no creator unlocked
 * or vesting LP (@242, @201, so creator permanently locked @241 = 100), no migration fee (@247) and no pool creation
 * fee (u64 @368). The Zero-PvP preset (PresetNotAllowed 6023) is checked first, so the breakers it already covers fail
 * with 6023; the rest fail with RetentionPresetInvalid (6024), and a rejected init_market moves no funds. Any other
 * fee_claimer opens a legacy market (retention 0) exactly as before, even with those fields set. Every market tracks
 * Market.basis_bought_total (@274): each buy adds its basis, sells and auto-exits never lower it.
 *
 * Every config is created by the real DBC program: `withFeeClaimer` rewrites the fee_claimer account of the fixture's
 * create_config_with_transfer_hook instruction before it is sent (DBC accepts any fee_claimer), and the test compares
 * the config bytes at the router's offsets with the DBC IDL decode. No config bytes are patched.
 *
 * Usage: npx tsx src/zpvp_retention.ts SCENARIOS.json INDEX   (ROUTER_SO=... picks the router binary; the quote is a
 * fresh mint, so this needs the `unrestricted` build)
 */
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, createApproveCheckedInstruction } from '@solana/spl-token'
import type { PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Chain, TxResult, liteSvmChain } from './chain'
import {
  BASE_DECIMALS, HOOK_ID, MarketFixture, ROUTER_ID, Scenario, anchorError, check, createMarketFixture, dbc, disc,
  eventAuthority, meta, must, pda, poolAuthority,
} from './fixture'
import { zpvpPrograms } from './zpvp_e2e'

const ERRORS = {
  presetNotAllowed: { code: 6023, name: 'PresetNotAllowed', message: /Error Message: Config breaks the Zero-PvP preset/ },
  retentionPresetInvalid: {
    code: 6024, name: 'RetentionPresetInvalid',
    message: /Error Message: Retention config needs no creator trading fee, partner LP, unlocked or vesting LP, migration or pool creation fee/,
  },
} as const
type RouterError = (typeof ERRORS)[keyof typeof ERRORS]

const FEES_SEED = Buffer.from('fees')
const feeAuthority = (config: PublicKey, programId = ROUTER_ID) => pda([FEES_SEED, config.toBuffer()], programId)

// Market (borsh): disc 8 | pool 32 | config 32 | ... | total_basis u64 @241 | finalized @249 | surplus_snapshot @250 |
// basis_snapshot @258 | surplus_claimed @266 | then, appended by ONC-15:
const MARKET_LEN = 300
const MARKET = {
  pool: 8, config: 40, totalBasis: 241, finalized: 249, surplusSnapshot: 250, basisSnapshot: 258, surplusClaimed: 266,
  basisBoughtTotal: 274, retention: 282, feesSettled: 283, feesClaimed: 284, creatorPaid: 292,
} as const
const CONFIG_WITH_TRANSFER_HOOK_LEN = 1128
const CONFIG_FEE_CLAIMER_OFFSET = 40

/** ConfigWithTransferHook.config as the DBC IDL decodes it. */
type DecodedConfig = PoolConfig
/** Retention preset fields: raw at `offset` (u8 or u64 LE) and decoded with the DBC IDL by `idl`. */
const CONFIG_FIELDS = {
  creatorTradingFee: { offset: 245, size: 1, idl: (c: DecodedConfig) => c.creatorTradingFeePercentage },
  partnerLp: { offset: 240, size: 1, idl: (c: DecodedConfig) => c.partnerLiquidityPercentage },
  partnerPermanentLockedLp: { offset: 239, size: 1, idl: (c: DecodedConfig) => c.partnerPermanentLockedLiquidityPercentage },
  partnerLpVesting: { offset: 185, size: 1, idl: (c: DecodedConfig) => c.partnerLiquidityVestingInfo.vestingPercentage },
  creatorLp: { offset: 242, size: 1, idl: (c: DecodedConfig) => c.creatorLiquidityPercentage },
  creatorLpVesting: { offset: 201, size: 1, idl: (c: DecodedConfig) => c.creatorLiquidityVestingInfo.vestingPercentage },
  migrationFee: { offset: 247, size: 1, idl: (c: DecodedConfig) => c.migrationFeePercentage },
  poolCreationFee: { offset: 368, size: 8, idl: (c: DecodedConfig) => c.poolCreationFee },
  // not read by the router: the retention preset leaves it 100
  creatorPermanentLockedLp: { offset: 241, size: 1, idl: (c: DecodedConfig) => c.creatorPermanentLockedLiquidityPercentage },
} as const
type ConfigField = keyof typeof CONFIG_FIELDS
type ConfigValues = Record<ConfigField, bigint>
const FIELD_NAMES = Object.keys(CONFIG_FIELDS) as ConfigField[]
const ZERO_VALUES = Object.fromEntries(FIELD_NAMES.map((f) => [f, 0n])) as ConfigValues
/** The retention preset: every field 0, all LP permanently locked by the creator. */
const RETENTION_VALUES: ConfigValues = { ...ZERO_VALUES, creatorPermanentLockedLp: 100n }
const RETENTION_LP = { partnerPermanentLockedLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 100 }

/** Who a config names as fee_claimer: the router's fee authority PDA (retention) or anyone else (legacy). */
type FeeClaimer = { what: string; of: (config: PublicKey, admin: PublicKey) => PublicKey }
const FEE_AUTHORITY: FeeClaimer = { what: 'the fees PDA', of: (config) => feeAuthority(config) }
const ADMIN: FeeClaimer = { what: 'the admin', of: (_, admin) => admin }
/** Look like the fee authority but are not it. */
const OTHER_CONFIG = Keypair.generate().publicKey
const NEAR_MISSES: FeeClaimer[] = [
  { what: "another config's fees PDA", of: () => feeAuthority(OTHER_CONFIG) },
  { what: 'the fees PDA seeds under the hook program', of: (config) => feeAuthority(config, HOOK_ID) },
]

/** A config made from the default fixture parameters plus `overrides`; `expect` is every retention field's value. */
type ConfigCase = { label: string; feeClaimer: FeeClaimer; overrides: Record<string, unknown>; expect: ConfigValues }
type RejectedCase = ConfigCase & { error: RouterError }

type Ctx = { chain: Chain; admin: Keypair; scenario: Scenario; quoteMint: PublicKey }

const TRADERS = 3
const TRADER_LAMPORTS = 10n ** 15n
/** Far below the graduation threshold and the Anti-Whale cap (20% of the curve supply). */
const BUY = 10n ** 9n
/** LiteSVM charges a failed transaction's fee (5000 lamports per signature), like the runtime. */
const TX_FEE = 5_000n
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32
const U64_MAX = 2n ** 64n - 1n
const ANCHOR_ERROR = /Error Code: \w+\. Error Number: \d+/

function loadScenario(): Scenario {
  const [scenarioPath, indexArg] = process.argv.slice(2)
  if (!scenarioPath) throw new Error('usage: zpvp_retention.ts SCENARIOS.json INDEX')
  const index = Number(indexArg ?? 0)
  const scenario: Scenario | undefined = JSON.parse(readFileSync(scenarioPath, 'utf8'))[index]
  if (!scenario) throw new Error(`no scenario at index ${index} in ${scenarioPath}`)
  return scenario
}

const errorDetail = (r: TxResult) => (r.ok ? 'SUCCEEDED' : r.error.match(ANCHOR_ERROR)?.[0] ?? r.error.replace(/\s+/g, ' ').slice(0, 110))

// --- configs through the real DBC program, with the fee_claimer we choose

const CREATE_CONFIG_WITH_HOOK = disc('create_config_with_transfer_hook')
const createConfigAccounts = (dbc.idl.instructions as unknown as { name: string; accounts: { name: string }[] }[])
  .find((ix) => ix.name === 'createConfigWithTransferHook')?.accounts.map((a) => a.name) ?? []
const CONFIG_ACCOUNT = createConfigAccounts.indexOf('config')
const FEE_CLAIMER_ACCOUNT = createConfigAccounts.indexOf('feeClaimer')
if (CONFIG_ACCOUNT < 0 || FEE_CLAIMER_ACCOUNT < 0) throw new Error('DBC IDL: create_config_with_transfer_hook has no config / fee_claimer account')

/** `chain`, except that DBC create_config_with_transfer_hook names `feeClaimer.of(config)` as its fee_claimer. */
function withFeeClaimer(chain: Chain, feeClaimer: FeeClaimer, admin: PublicKey): Chain {
  const rewrite = (ix: TransactionInstruction) => {
    if (!ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) || !ix.data.subarray(0, 8).equals(CREATE_CONFIG_WITH_HOOK)) return ix
    const claimer = feeClaimer.of(ix.keys[CONFIG_ACCOUNT].pubkey, admin)
    const keys = ix.keys.map((k, i) => (i === FEE_CLAIMER_ACCOUNT ? { ...k, pubkey: claimer } : k))
    return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys })
  }
  return { ...chain, send: (payer, ixs, signers) => chain.send(payer, ixs.map(rewrite), signers) }
}

async function configBytes(chain: Chain, config: PublicKey): Promise<Buffer> {
  const data = await chain.accountData(config)
  if (!data || data.length !== CONFIG_WITH_TRANSFER_HOOK_LEN) throw new Error(`config ${config.toBase58()}: expected ${CONFIG_WITH_TRANSFER_HOOK_LEN} bytes`)
  return data
}

function rawValues(data: Buffer): ConfigValues {
  const read = ({ offset, size }: { offset: number; size: number }) => (size === 1 ? BigInt(data[offset]) : data.readBigUInt64LE(offset))
  return Object.fromEntries(FIELD_NAMES.map((f) => [f, read(CONFIG_FIELDS[f])])) as ConfigValues
}

const decodedConfig = (data: Buffer): DecodedConfig => dbc.coder.accounts.decode('configWithTransferHook', data).config
const decodedValues = (c: DecodedConfig) =>
  Object.fromEntries(FIELD_NAMES.map((f) => [f, BigInt(CONFIG_FIELDS[f].idl(c).toString())])) as ConfigValues
const show = (v: ConfigValues) => FIELD_NAMES.map((f) => `${f}@${CONFIG_FIELDS[f].offset}=${v[f]}`).join(' ')

/** Creates a DBC config + pool (no market) for `c`, and checks its bytes at the router's offsets against the IDL and `c`. */
async function poolFor(ctx: Ctx, c: ConfigCase, traderCount = 0): Promise<MarketFixture> {
  const { admin, scenario, quoteMint } = ctx
  const chain = withFeeClaimer(ctx.chain, c.feeClaimer, admin.publicKey)
  const m = await createMarketFixture(chain, admin, scenario, {
    wsol: false, traderCount, traderLamports: TRADER_LAMPORTS, quoteMint, skipMarket: true, configOverrides: c.overrides,
  })
  const data = await configBytes(chain, m.config.publicKey)
  const decoded = decodedConfig(data)
  const [raw, idl] = [rawValues(data), decodedValues(decoded)]
  check(FIELD_NAMES.every((f) => raw[f] === idl[f] && raw[f] === c.expect[f]),
    `${c.label}: DBC wrote the expected retention fields at the router's offsets (raw bytes = DBC IDL decode)`, show(raw))
  const claimer = new PublicKey(data.subarray(CONFIG_FEE_CLAIMER_OFFSET, CONFIG_FEE_CLAIMER_OFFSET + 32))
  const expected = c.feeClaimer.of(m.config.publicKey, admin.publicKey)
  check(claimer.equals(decoded.feeClaimer) && claimer.equals(expected),
    `${c.label}: fee_claimer @${CONFIG_FEE_CLAIMER_OFFSET} is ${c.feeClaimer.what} (raw bytes = DBC IDL decode)`, claimer.toBase58())
  return m
}

// --- init_market

const marketBytes = async (chain: Chain, market: PublicKey) => (await chain.accountData(market)) ?? Buffer.alloc(0)
const u64At = (data: Buffer, offset: number) => data.readBigUInt64LE(offset)

/** init_market on a fresh pool for `c`; checks the new market's layout and that `retention` @282 is `retention`. */
async function opens(ctx: Ctx, c: ConfigCase, retention: 0 | 1, traderCount = 0): Promise<MarketFixture> {
  console.log(`-- ${c.label}`)
  const m = await poolFor(ctx, c, traderCount)
  const r = await ctx.chain.send(ctx.admin, [m.initMarketIx()])
  const data = await marketBytes(ctx.chain, m.market)
  check(r.ok && data.length === MARKET_LEN && data.subarray(MARKET.pool, MARKET.pool + 32).equals(m.pool.toBuffer()) &&
    data.subarray(MARKET.config, MARKET.config + 32).equals(m.config.publicKey.toBuffer()),
  `${c.label}: init_market opens a ${MARKET_LEN}-byte market (pool @${MARKET.pool}, config @${MARKET.config})`,
  r.ok ? `${data.length} bytes` : errorDetail(r))
  check(data[MARKET.retention] === retention,
    `${c.label} → retention = ${retention} (byte @${MARKET.retention})`, `byte @${MARKET.retention} = ${data[MARKET.retention]}`)
  const fresh = data.length === MARKET_LEN && [MARKET.totalBasis, MARKET.surplusSnapshot, MARKET.basisSnapshot, MARKET.surplusClaimed,
    MARKET.basisBoughtTotal, MARKET.feesClaimed, MARKET.creatorPaid].every((o) => u64At(data, o) === 0n)
  check(fresh && data[MARKET.finalized] === 0 && data[MARKET.feesSettled] === 0,
    `${c.label}: total_basis, snapshots, basis_bought_total @${MARKET.basisBoughtTotal}, fees_claimed @${MARKET.feesClaimed} and ` +
    `creator_paid @${MARKET.creatorPaid} start at 0, finalized @${MARKET.finalized} and fees_settled @${MARKET.feesSettled} false`)
  return m
}

/** Hex and lamports of every watched account; equal before and after means nothing moved. */
const stateOf = (chain: Chain, accounts: PublicKey[]) =>
  Promise.all(accounts.map(async (a) => `${await chain.lamports(a)}:${(await chain.accountData(a))?.toString('hex') ?? 'missing'}`))

/** init_market on a fresh pool for `c` fails with exactly `c.error` and moves nothing but the tx fee. */
async function rejected(ctx: Ctx, c: RejectedCase): Promise<void> {
  console.log(`-- ${c.label}`)
  const { chain, admin } = ctx
  const m = await poolFor(ctx, c)
  const watched = [m.market, m.buffer, m.config.publicKey, m.pool, m.baseVault, m.quoteVault, m.baseMint.publicKey]
  const [before, payerBefore] = [await stateOf(chain, watched), await chain.lamports(admin.publicKey)]
  const r = await chain.send(admin, [m.initMarketIx()])
  const [after, payerAfter] = [await stateOf(chain, watched), await chain.lamports(admin.publicKey)]
  const { code, name, message } = c.error
  check(!r.ok && anchorError(code, name).test(r.error) && message.test(r.error),
    `${c.label} → init_market rejected ${code} ${name}`, errorDetail(r))
  const payerPaid = payerBefore - payerAfter
  const changed = watched.filter((_, i) => after[i] !== before[i]).map((a) => a.toBase58())
  const noMarket = !(await chain.accountData(m.market)) && !(await chain.accountData(m.buffer))
  check(changed.length === 0 && noMarket && payerPaid === TX_FEE,
    `${c.label} → the rejection moves no funds (no market, no buffer vault; the payer pays only the tx fee)`,
    `payer -${payerPaid}${changed.length ? `, changed: ${changed.join(', ')}` : ''}`)
}

// --- basis_bought_total: buys add their basis, sells and auto-exits never lower it

const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b }

/** set_auto_exit(deadline). Accounts: owner (signer), market, position (mut). */
const setAutoExitIx = (m: MarketFixture, i: number, deadline: bigint) => new TransactionInstruction({
  programId: ROUTER_ID, data: Buffer.concat([disc('set_auto_exit'), i64(deadline)]),
  keys: [meta(m.traders[i].publicKey, false, true), meta(m.market), meta(m.positionOf(i), true)],
})

/** auto_exit() of trader `i`'s position: cranker, owner, market, position, owner ATAs, buffer, DBC swap accounts, hook accounts. */
const autoExitIx = (m: MarketFixture, cranker: PublicKey, i: number) => new TransactionInstruction({
  programId: ROUTER_ID, data: disc('auto_exit'),
  keys: [
    meta(cranker, false, true), meta(m.traders[i].publicKey), meta(m.market, true), meta(m.positionOf(i), true),
    meta(m.ata[i].quote, true), meta(m.ata[i].base, true), meta(m.buffer, true),
    meta(poolAuthority), meta(m.config.publicKey), meta(m.pool, true), meta(m.baseVault, true), meta(m.quoteVault, true),
    meta(m.baseMint.publicKey, true), meta(m.quoteMintPk), meta(TOKEN_2022_PROGRAM_ID), meta(m.quoteTokenProgram),
    meta(eventAuthority), meta(DYNAMIC_BONDING_CURVE_PROGRAM_ID), meta(SystemProgram.programId), ...m.hookAccounts,
  ],
})

/** Trader `i` approves the market PDA as delegate of their base ATA (the SDK approves u64::MAX before auto-exit). */
const approveMarketIx = (m: MarketFixture, i: number) => createApproveCheckedInstruction(
  m.ata[i].base, m.baseMint.publicKey, m.market, m.traders[i].publicKey, U64_MAX, BASE_DECIMALS, [], TOKEN_2022_PROGRAM_ID)

async function unixTimestamp(chain: Chain): Promise<bigint> {
  const clock = await chain.accountData(SYSVAR_CLOCK_PUBKEY)
  if (!clock) throw new Error('clock sysvar missing')
  return clock.readBigInt64LE(CLOCK_UNIX_TIMESTAMP_OFFSET)
}

async function basisBoughtTotal(m: MarketFixture, label: string): Promise<void> {
  const { chain, traders } = m
  const market = async () => {
    const data = await marketBytes(chain, m.market)
    return { bought: u64At(data, MARKET.basisBoughtTotal), open: u64At(data, MARKET.totalBasis) }
  }
  let added = 0n // every buy's basis, from the position deltas
  const buy = async (i: number, amount: bigint) => {
    const before = await m.readPosition(i)
    must(await chain.send(traders[i], m.buyIxs(i, amount)), `${label}: trader ${i} buys`)
    const basis = (await m.readPosition(i)).basis - before.basis
    added += basis
    return basis
  }
  /** Runs `exit` and checks that it lowered total_basis by the exited basis and left basis_bought_total alone. */
  const exitKeeps = async (what: string, i: number, exit: () => Promise<TxResult>) => {
    const [before, position] = [await market(), await m.readPosition(i)]
    must(await exit(), `${label}: ${what}`)
    const [after, left] = [await market(), await m.readPosition(i)]
    const exited = position.basis - left.basis
    check(exited > 0n && after.open === before.open - exited && after.bought === before.bought && after.bought === added,
      `${label}: ${what} leaves basis_bought_total unchanged (total_basis -${exited})`,
      `basis_bought_total ${before.bought} -> ${after.bought}, total_basis ${before.open} -> ${after.open}`)
  }

  console.log(`-- ${label}: basis_bought_total`)
  const first = await buy(0, BUY)
  let state = await market()
  check(first > 0n && state.bought === first && state.open === first,
    `${label}: basis_bought_total grows by the first buy's basis (= total_basis)`, `basis_bought_total ${state.bought}`)
  await buy(1, 2n * BUY)
  state = await market()
  check(state.bought === added && state.open === added, `${label}: basis_bought_total grows by a second trader's buy`,
    `basis_bought_total ${state.bought}, buys ${added}`)
  const tokens0 = (await m.readPosition(0)).tokens
  await exitKeeps('a partial sell', 0, () => chain.send(traders[0], [m.sellIx(0, tokens0 / 2n)]))
  const rebuy = await buy(0, BUY)
  state = await market()
  check(state.bought === added && state.open < state.bought,
    `${label}: basis_bought_total grows by a re-buy after the sell (and stays above total_basis)`,
    `+${rebuy}: basis_bought_total ${state.bought}, total_basis ${state.open}`)
  const tokens1 = (await m.readPosition(1)).tokens
  await exitKeeps('a full sell', 1, () => chain.send(traders[1], [m.sellIx(1, tokens1)]))

  await buy(2, BUY)
  const deadline = (await unixTimestamp(chain)) + 1n
  must(await chain.send(traders[2], [approveMarketIx(m, 2), setAutoExitIx(m, 2, deadline)]), `${label}: trader 2 arms auto-exit`)
  if (!chain.setClock) throw new Error(`${chain.name}: cannot warp the clock (LiteSVM only)`)
  chain.setClock(deadline)
  await exitKeeps('an auto_exit crank', 2, () => chain.send(traders[0], [autoExitIx(m, traders[0].publicKey, 2)]))
}

// --- cases

/** DBC LP vesting after migration: `bpsPerPeriod` of the vested LP every `frequency` seconds, no cliff. */
const lpVesting = (vestingPercentage: number, bpsPerPeriod: number, numberOfPeriods: number, frequency: number) =>
  ({ vestingPercentage, bpsPerPeriod, numberOfPeriods, cliffDurationFromMigrationTime: 0, frequency })
const POOL_CREATION_FEE = 10_000_000n // 0.01 SOL

/** Retention configs (fee_claimer = the fees PDA) that each break one retention preset rule. */
const RETENTION_BREAKERS: RejectedCase[] = [
  { label: 'retention + partner LP 7 (unlocked)', error: ERRORS.presetNotAllowed,
    overrides: { ...RETENTION_LP, creatorPermanentLockedLiquidityPercentage: 93, partnerLiquidityPercentage: 7 },
    feeClaimer: FEE_AUTHORITY, expect: { ...RETENTION_VALUES, creatorPermanentLockedLp: 93n, partnerLp: 7n } },
  { label: 'retention + partner LP vesting 50', error: ERRORS.presetNotAllowed,
    overrides: { ...RETENTION_LP, creatorPermanentLockedLiquidityPercentage: 50, partnerLiquidityVestingInfo: lpVesting(50, 1_000, 10, 60) },
    feeClaimer: FEE_AUTHORITY, expect: { ...RETENTION_VALUES, creatorPermanentLockedLp: 50n, partnerLpVesting: 50n } },
  { label: 'retention + creator LP 13 (unlocked)', error: ERRORS.presetNotAllowed,
    overrides: { ...RETENTION_LP, creatorPermanentLockedLiquidityPercentage: 87, creatorLiquidityPercentage: 13 },
    feeClaimer: FEE_AUTHORITY, expect: { ...RETENTION_VALUES, creatorPermanentLockedLp: 87n, creatorLp: 13n } },
  { label: 'retention + creator LP vesting 40', error: ERRORS.presetNotAllowed,
    overrides: { ...RETENTION_LP, creatorPermanentLockedLiquidityPercentage: 60, creatorLiquidityVestingInfo: lpVesting(40, 500, 20, 30) },
    feeClaimer: FEE_AUTHORITY, expect: { ...RETENTION_VALUES, creatorPermanentLockedLp: 60n, creatorLpVesting: 40n } },
  { label: 'retention + migration fee 10%', error: ERRORS.presetNotAllowed,
    overrides: { ...RETENTION_LP, migrationFee: { feePercentage: 10, creatorFeePercentage: 0 } },
    feeClaimer: FEE_AUTHORITY, expect: { ...RETENTION_VALUES, migrationFee: 10n } },
  { label: 'retention + creator trading fee 50%', error: ERRORS.retentionPresetInvalid,
    overrides: { ...RETENTION_LP, creatorTradingFeePercentage: 50 },
    feeClaimer: FEE_AUTHORITY, expect: { ...RETENTION_VALUES, creatorTradingFee: 50n } },
  { label: 'retention + partner / creator LP 50 / 50 permanently locked', error: ERRORS.retentionPresetInvalid,
    overrides: { partnerPermanentLockedLiquidityPercentage: 50, creatorPermanentLockedLiquidityPercentage: 50 },
    feeClaimer: FEE_AUTHORITY, expect: { ...RETENTION_VALUES, partnerPermanentLockedLp: 50n, creatorPermanentLockedLp: 50n } },
  { label: `retention + pool creation fee ${POOL_CREATION_FEE} lamports`, error: ERRORS.retentionPresetInvalid,
    overrides: { ...RETENTION_LP, poolCreationFee: new BN(POOL_CREATION_FEE.toString()) },
    feeClaimer: FEE_AUTHORITY, expect: { ...RETENTION_VALUES, poolCreationFee: POOL_CREATION_FEE } },
]

const RETENTION: ConfigCase = {
  label: 'retention config (fee_claimer = the fees PDA, retention preset)', feeClaimer: FEE_AUTHORITY, overrides: RETENTION_LP,
  expect: RETENTION_VALUES,
}
const LEGACY: ConfigCase = {
  label: 'legacy config (the default fixture: fee_claimer = the admin, partner LP 100% permanently locked)', feeClaimer: ADMIN,
  overrides: {}, expect: { ...ZERO_VALUES, partnerPermanentLockedLp: 100n },
}

async function main() {
  const scenario = loadScenario()
  const chain = liteSvmChain(zpvpPrograms())
  const admin = Keypair.generate()
  await chain.fund(admin.publicKey, 10n ** 16n)
  // one quote mint for every config (a fresh mint: needs the unrestricted build)
  const reference = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: 0, traderLamports: 0n, skipMarket: true })
  const ctx: Ctx = { chain, admin, scenario, quoteMint: reference.quoteMintPk }

  const retention = await opens(ctx, RETENTION, 1, TRADERS)
  const legacy = await opens(ctx, LEGACY, 0, TRADERS)
  await opens(ctx, { ...LEGACY, label: 'legacy config with the retention LP split (fee_claimer = the admin)', overrides: RETENTION_LP,
    expect: RETENTION_VALUES }, 0)
  for (const claimer of NEAR_MISSES) {
    await opens(ctx, { ...RETENTION, label: `retention preset with fee_claimer = ${claimer.what} (legacy)`, feeClaimer: claimer }, 0)
  }
  // the retention-only rules do not touch legacy markets
  for (const c of RETENTION_BREAKERS.filter((b) => b.error === ERRORS.retentionPresetInvalid)) {
    await opens(ctx, { ...c, label: `${c.label.replace('retention', 'legacy')} (fee_claimer = the admin)`, feeClaimer: ADMIN }, 0)
  }

  await basisBoughtTotal(retention, 'retention market')
  await basisBoughtTotal(legacy, 'legacy market')

  for (const c of RETENTION_BREAKERS) await rejected(ctx, c)
}

main().catch((e) => { console.error(e); process.exit(1) })
