/**
 * Zero-PvP preset (ONC-14) on LiteSVM. `init_market` opens a market only for a DBC config where no insider gets tokens
 * or pullable liquidity at graduation. That means no creator token allocation (locked vesting
 * amount_per_period == 0 and cliff_unlock_amount == 0), dynamic supply (fixed_token_supply_flag == 0, so nothing
 * leftover goes to leftover_receiver) and all LP permanently locked (partner_liquidity_percentage == 0,
 * creator_liquidity_percentage == 0, and partner + creator permanently locked == 100, which leaves nothing for DBC
 * liquidity vesting), no migration fee (migration_fee_percentage == 0 and creator_migration_fee_percentage == 0, so DBC
 * pays nobody a cut of the graduation quote) and DAMM v2 migration (migration_option == 1). Any other config is
 * rejected with PresetNotAllowed (6023), and the rejected init_market moves no funds: the market and buffer PDAs stay
 * empty and no watched account changes.
 *
 * The real DBC program creates every config. Before init_market, the test reads the preset fields from the config's
 * bytes at the router's offsets (ConfigWithTransferHook: migration_option @233, permanently locked LP partner @239 /
 * creator @241, unlocked LP partner @240 / creator @242, fixed supply flag @244, migration fee @247 / creator share
 * @248, locked_vesting.amount_per_period @296, locked_vesting.cliff_unlock_amount @328) plus the LP vesting
 * percentages (partner @185, creator @201), and compares each with the DBC IDL decode. DBC itself refuses to create a
 * creator migration fee without a migration fee and DAMM v1 migration; for those two the test shows DBC's refusal, then
 * patches a default config's bytes in LiteSVM (the router must still reject such a config, e.g. one DBC wrote before
 * it added the check).
 *
 * Usage: npx tsx src/zpvp_preset.ts SCENARIOS.json INDEX   (ROUTER_SO=... picks the router binary; the quote is a
 * fresh mint, so this needs the `unrestricted` build)
 */
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { Keypair, PublicKey } from '@solana/web3.js'
import type { PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Chain, TxResult, liteSvmChain } from './chain'
import { CONFIG_SWAP_BASE_AMOUNT_OFFSET, MarketFixture, ROUTER_ID, Scenario, anchorError, check, createMarketFixture, dbc } from './fixture'
import { zpvpPrograms } from './zpvp_e2e'

const PRESET_NOT_ALLOWED = 6023
const presetNotAllowed = anchorError(PRESET_NOT_ALLOWED, 'PresetNotAllowed')
const PRESET_MESSAGE = /Error Message: Config breaks the Zero-PvP preset \(creator allocation, fixed supply or unlocked LP\)/
const CONFIG_WITH_TRANSFER_HOOK_LEN = 1128
// ConfigWithTransferHook: migration_base_threshold follows migration_quote_threshold (264)
const CONFIG_MIGRATION_BASE_THRESHOLD_OFFSET = 272
/** DBC mints swap_base_amount plus a 25% buffer before migration; twice the swap amount always covers it. */
const FIXED_SUPPLY_SWAP_MULTIPLE = 2n
const U64_MAX = 2n ** 64n - 1n
/** LiteSVM charges a failed transaction's fee (5000 lamports per signature), like the runtime. */
const TX_FEE = 5_000n
const ANCHOR_ERROR = /Error Code: \w+\. Error Number: \d+/

/** ConfigWithTransferHook.config as the DBC IDL decodes it. */
type DecodedConfig = PoolConfig
/** Config fields the test checks: raw at `offset` (u8 or u64 LE) and decoded with the DBC IDL by `idl`. */
const CONFIG_FIELDS = {
  partnerPermanentLockedLp: { offset: 239, size: 1, idl: (c: DecodedConfig) => c.partnerPermanentLockedLiquidityPercentage },
  partnerLp: { offset: 240, size: 1, idl: (c: DecodedConfig) => c.partnerLiquidityPercentage },
  creatorPermanentLockedLp: { offset: 241, size: 1, idl: (c: DecodedConfig) => c.creatorPermanentLockedLiquidityPercentage },
  creatorLp: { offset: 242, size: 1, idl: (c: DecodedConfig) => c.creatorLiquidityPercentage },
  fixedTokenSupplyFlag: { offset: 244, size: 1, idl: (c: DecodedConfig) => c.fixedTokenSupplyFlag },
  amountPerPeriod: { offset: 296, size: 8, idl: (c: DecodedConfig) => c.lockedVestingConfig.amountPerPeriod },
  cliffUnlockAmount: { offset: 328, size: 8, idl: (c: DecodedConfig) => c.lockedVestingConfig.cliffUnlockAmount },
  migrationOption: { offset: 233, size: 1, idl: (c: DecodedConfig) => c.migrationOption },
  migrationFeePercentage: { offset: 247, size: 1, idl: (c: DecodedConfig) => c.migrationFeePercentage },
  creatorMigrationFeePercentage: { offset: 248, size: 1, idl: (c: DecodedConfig) => c.creatorMigrationFeePercentage },
  // not read by the router: the permanently locked sum of 100 leaves them 0
  partnerLpVestingPercentage: { offset: 185, size: 1, idl: (c: DecodedConfig) => c.partnerLiquidityVestingInfo.vestingPercentage },
  creatorLpVestingPercentage: { offset: 201, size: 1, idl: (c: DecodedConfig) => c.creatorLiquidityVestingInfo.vestingPercentage },
} as const
type ConfigField = keyof typeof CONFIG_FIELDS
type ConfigValues = Record<ConfigField, bigint>
const FIELD_NAMES = Object.keys(CONFIG_FIELDS) as ConfigField[]
/** DBC MigrationOption::MetDammV2; MetDamm (DAMM v1) is 0. */
const MIGRATION_OPTION_DAMM_V2 = 1n
const MIGRATION_OPTION_DAMM_V1 = 0n
/** The default fixture config: DAMM v2 migration, partner LP 100% permanently locked, everything else 0. */
const DEFAULT_VALUES: ConfigValues = {
  ...(Object.fromEntries(FIELD_NAMES.map((f) => [f, 0n])) as ConfigValues),
  partnerPermanentLockedLp: 100n, migrationOption: MIGRATION_OPTION_DAMM_V2,
}

type Ctx = { chain: Chain; admin: Keypair; scenario: Scenario; quoteMint: PublicKey }

/** A config made from the default fixture parameters plus `overrides`; `expect` lists the fields that differ. */
type ConfigCase = { label: string; overrides: Record<string, unknown>; expect: Partial<ConfigValues> }
/**
 * A config DBC itself refuses to create: `refused` holds the parameters and DBC's error. The router is checked on a
 * default config whose bytes are then set to `patch` in LiteSVM.
 */
type PatchedCase = { label: string; refused: { overrides: Record<string, unknown>; error: string }; patch: Partial<ConfigValues> }

function loadScenario(): Scenario {
  const [scenarioPath, indexArg] = process.argv.slice(2)
  if (!scenarioPath) throw new Error('usage: zpvp_preset.ts SCENARIOS.json INDEX')
  const index = Number(indexArg ?? 0)
  const scenario: Scenario | undefined = JSON.parse(readFileSync(scenarioPath, 'utf8'))[index]
  if (!scenario) throw new Error(`no scenario at index ${index} in ${scenarioPath}`)
  return scenario
}

const errorDetail = (r: TxResult) =>
  (r.ok ? 'SUCCEEDED (preset not enforced!)' : r.error.match(ANCHOR_ERROR)?.[0] ?? r.error.replace(/\s+/g, ' ').slice(0, 110))

async function configBytes(chain: Chain, config: PublicKey): Promise<Buffer> {
  const data = await chain.accountData(config)
  if (!data || data.length !== CONFIG_WITH_TRANSFER_HOOK_LEN) throw new Error(`config ${config.toBase58()}: expected ${CONFIG_WITH_TRANSFER_HOOK_LEN} bytes`)
  return data
}

function rawValues(data: Buffer): ConfigValues {
  const read = ({ offset, size }: { offset: number; size: number }) => (size === 1 ? BigInt(data[offset]) : data.readBigUInt64LE(offset))
  return Object.fromEntries(FIELD_NAMES.map((f) => [f, read(CONFIG_FIELDS[f])])) as ConfigValues
}

function decodedValues(data: Buffer): ConfigValues {
  const c = dbc.coder.accounts.decode('configWithTransferHook', data).config
  return Object.fromEntries(FIELD_NAMES.map((f) => [f, BigInt(CONFIG_FIELDS[f].idl(c).toString())])) as ConfigValues
}

const show = (v: ConfigValues) => FIELD_NAMES.map((f) => `${f}@${CONFIG_FIELDS[f].offset}=${v[f]}`).join(' ')

/** Creates a DBC config + pool (no market) for `c`, and checks the config's bytes against the IDL and `c.expect`. */
async function poolFor(ctx: Ctx, c: ConfigCase): Promise<MarketFixture> {
  const { chain, admin, scenario, quoteMint } = ctx
  const m = await createMarketFixture(chain, admin, scenario, {
    wsol: false, traderCount: 0, traderLamports: 0n, quoteMint, skipMarket: true, configOverrides: c.overrides,
  })
  const data = await configBytes(chain, m.config.publicKey)
  const [raw, decoded, expected] = [rawValues(data), decodedValues(data), { ...DEFAULT_VALUES, ...c.expect }]
  check(FIELD_NAMES.every((f) => raw[f] === decoded[f] && raw[f] === expected[f]),
    `${c.label}: DBC wrote the expected values at the router's offsets (raw bytes = DBC IDL decode)`, show(raw))
  return m
}

/** Hex and lamports of every watched account; equal before and after means nothing moved. */
const stateOf = (chain: Chain, accounts: PublicKey[]) =>
  Promise.all(accounts.map(async (a) => `${await chain.lamports(a)}:${(await chain.accountData(a))?.toString('hex') ?? 'missing'}`))

const bufferOf = (market: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('buffer'), market.toBuffer()], ROUTER_ID)[0]

async function opens(ctx: Ctx, c: ConfigCase): Promise<void> {
  const { chain, admin } = ctx
  console.log(`-- ${c.label}`)
  const m = await poolFor(ctx, c)
  const r = await chain.send(admin, [m.initMarketIx()])
  const market = await chain.accountData(m.market)
  const buffer = await chain.accountData(m.buffer)
  check(r.ok && !!market && market.subarray(8, 40).equals(m.pool.toBuffer()) && !!buffer,
    `${c.label} opens a market (market and buffer vault created)`, r.ok ? '' : errorDetail(r))
}

async function rejected(ctx: Ctx, c: ConfigCase): Promise<void> {
  console.log(`-- ${c.label}`)
  await initMarketRejected(ctx, c.label, await poolFor(ctx, c))
}

/** Shows that DBC refuses `c.refused`, then that init_market rejects a default config patched to `c.patch`. */
async function rejectedPatched(ctx: Ctx, c: PatchedCase): Promise<void> {
  console.log(`-- ${c.label}`)
  const { chain, admin, scenario, quoteMint } = ctx
  const outcome = await createMarketFixture(chain, admin, scenario, {
    wsol: false, traderCount: 0, traderLamports: 0n, quoteMint, skipMarket: true, configOverrides: c.refused.overrides,
  }).then(() => 'DBC created the config', (e: Error) => e.message)
  check(outcome.includes(`Error Code: ${c.refused.error}.`), `${c.label}: DBC itself refuses to create the config (${c.refused.error})`,
    outcome.includes(c.refused.error) ? '' : outcome.replace(/\s+/g, ' ').slice(0, 160))
  await initMarketRejected(ctx, c.label, await patchedPoolFor(ctx, c))
}

/** A default config + pool whose config bytes are then set to `c.patch` (owner, lamports and length unchanged). */
async function patchedPoolFor(ctx: Ctx, c: PatchedCase): Promise<MarketFixture> {
  const { chain } = ctx
  if (!chain.setAccount) throw new Error(`${chain.name}: cannot patch a config (LiteSVM only)`)
  const m = await poolFor(ctx, { label: `${c.label} (default config before the patch)`, overrides: {}, expect: {} })
  const address = m.config.publicKey
  const data = Buffer.from(await configBytes(chain, address))
  for (const [field, value] of Object.entries(c.patch) as [ConfigField, bigint][]) {
    const { offset, size } = CONFIG_FIELDS[field]
    if (size !== 1 || value > 0xffn) throw new Error(`patch ${field}: only u8 fields are patched`)
    data[offset] = Number(value)
  }
  chain.setAccount(address, { lamports: await chain.lamports(address), owner: dbc.programId, executable: false, data })
  const patched = await configBytes(chain, address)
  const [raw, decoded, expected] = [rawValues(patched), decodedValues(patched), { ...DEFAULT_VALUES, ...c.patch }]
  check(FIELD_NAMES.every((f) => raw[f] === decoded[f] && raw[f] === expected[f]),
    `${c.label}: the patched config reads as intended at the router's offsets (raw bytes = DBC IDL decode)`, show(raw))
  return m
}

async function initMarketRejected(ctx: Ctx, label: string, m: MarketFixture): Promise<void> {
  const { chain, admin } = ctx
  const watched = [m.market, bufferOf(m.market), m.config.publicKey, m.pool, m.baseVault, m.quoteVault, m.baseMint.publicKey]
  const [before, payerBefore] = [await stateOf(chain, watched), await chain.lamports(admin.publicKey)]
  const r = await chain.send(admin, [m.initMarketIx()])
  const [after, payerAfter] = [await stateOf(chain, watched), await chain.lamports(admin.publicKey)]
  check(!r.ok && presetNotAllowed.test(r.error) && PRESET_MESSAGE.test(r.error),
    `${label} → init_market rejected ${PRESET_NOT_ALLOWED} PresetNotAllowed`, errorDetail(r))
  const unchanged = after.every((s, i) => s === before[i])
  const noMarket = !(await chain.accountData(m.market)) && !(await chain.accountData(m.buffer))
  const payerPaid = payerBefore - payerAfter
  const changed = watched.filter((_, i) => after[i] !== before[i]).map((a) => a.toBase58())
  check(unchanged && noMarket && payerPaid === TX_FEE,
    `${label} → the rejection moves no funds (no market, no buffer vault; the payer pays only the tx fee)`,
    `payer -${payerPaid}${changed.length ? `, changed: ${changed.join(', ')}` : ''}`)
}

const LOCKED_VESTING_AMOUNT_PER_PERIOD = 1_234_567n
const LOCKED_VESTING_PERIODS = 10n
const LOCKED_VESTING_CLIFF_UNLOCK = 7_654_321n

function lockedVesting(amountPerPeriod: bigint, numberOfPeriod: bigint, cliffUnlockAmount: bigint) {
  return { lockedVesting: {
    amountPerPeriod: new BN(amountPerPeriod.toString()), cliffDurationFromMigrationTime: new BN(0), frequency: new BN(1),
    numberOfPeriod: new BN(numberOfPeriod.toString()), cliffUnlockAmount: new BN(cliffUnlockAmount.toString()) } }
}

/** DBC LP vesting after migration: `bpsPerPeriod` of the vested LP every `frequency` seconds, no cliff. */
const lpVesting = (vestingPercentage: number, bpsPerPeriod: number, numberOfPeriods: number, frequency: number) =>
  ({ vestingPercentage, bpsPerPeriod, numberOfPeriods, cliffDurationFromMigrationTime: 0, frequency })

/** Configs that each break exactly one preset rule; the fixed supply is sized from the default config's curve. */
async function presetBreakers(ctx: Ctx, reference: MarketFixture): Promise<ConfigCase[]> {
  const data = await configBytes(ctx.chain, reference.config.publicKey)
  const swapBase = data.readBigUInt64LE(CONFIG_SWAP_BASE_AMOUNT_OFFSET)
  const migrationBase = data.readBigUInt64LE(CONFIG_MIGRATION_BASE_THRESHOLD_OFFSET)
  const supply = swapBase * FIXED_SUPPLY_SWAP_MULTIPLE + migrationBase
  if (swapBase === 0n || supply > U64_MAX) throw new Error(`cannot size a fixed supply from swap_base_amount ${swapBase}`)
  const fixedSupply = new BN(supply.toString())
  return [
    { label: 'locked vesting amountPerPeriod > 0 (creator allocation)',
      overrides: lockedVesting(LOCKED_VESTING_AMOUNT_PER_PERIOD, LOCKED_VESTING_PERIODS, 0n),
      expect: { amountPerPeriod: LOCKED_VESTING_AMOUNT_PER_PERIOD } },
    { label: 'locked vesting cliffUnlockAmount > 0 (creator allocation at the cliff)',
      overrides: lockedVesting(0n, 0n, LOCKED_VESTING_CLIFF_UNLOCK), expect: { cliffUnlockAmount: LOCKED_VESTING_CLIFF_UNLOCK } },
    { label: 'fixed supply (tokenSupply set, leftover to leftover_receiver)',
      overrides: { tokenSupply: { preMigrationTokenSupply: fixedSupply, postMigrationTokenSupply: fixedSupply } },
      expect: { fixedTokenSupplyFlag: 1n } },
    { label: 'partnerLiquidityPercentage > 0 (unlocked partner LP)',
      overrides: { partnerPermanentLockedLiquidityPercentage: 93, partnerLiquidityPercentage: 7 },
      expect: { partnerPermanentLockedLp: 93n, partnerLp: 7n } },
    { label: 'creatorLiquidityPercentage > 0 (unlocked creator LP)',
      overrides: { partnerPermanentLockedLiquidityPercentage: 87, creatorLiquidityPercentage: 13 },
      expect: { partnerPermanentLockedLp: 87n, creatorLp: 13n } },
    { label: 'partner permanently locked 50 + partner LP vesting 50 (no unlocked LP, half vests in 10 minutes)',
      overrides: { partnerPermanentLockedLiquidityPercentage: 50, partnerLiquidityVestingInfo: lpVesting(50, 1_000, 10, 60) },
      expect: { partnerPermanentLockedLp: 50n, partnerLpVestingPercentage: 50n } },
    { label: 'partner permanently locked 60 + creator LP vesting 40 (no unlocked LP, vests in 10 minutes)',
      overrides: { partnerPermanentLockedLiquidityPercentage: 60, creatorLiquidityVestingInfo: lpVesting(40, 500, 20, 30) },
      expect: { partnerPermanentLockedLp: 60n, creatorLpVestingPercentage: 40n } },
    { label: 'migration fee 10% (DBC pays 10% of the graduation quote to the fee claimer instead of the DAMM v2 pool)',
      overrides: migrationFee(10, 0), expect: { migrationFeePercentage: 10n } },
    { label: 'migration fee 10% with a 50% creator share (the pool creator takes half of it)',
      overrides: migrationFee(10, 50), expect: { migrationFeePercentage: 10n, creatorMigrationFeePercentage: 50n } },
    { label: 'migration fee 99% with a 100% creator share (DBC maximum: the creator takes 99% of the graduation quote)',
      overrides: migrationFee(99, 100), expect: { migrationFeePercentage: 99n, creatorMigrationFeePercentage: 100n } },
  ]
}

/** DBC MigrationFee: `feePercentage` of the graduation quote is withheld from the pool, `creatorFeePercentage` of it
 * is the pool creator's and the rest the fee claimer's (both withdrawn with withdraw_migration_fee). */
const migrationFee = (feePercentage: number, creatorFeePercentage: number) => ({ migrationFee: { feePercentage, creatorFeePercentage } })

/** Configs DBC refuses to create; the router must reject them too. */
const PATCHED_BREAKERS: PatchedCase[] = [
  { label: 'creator migration fee 50% without a migration fee',
    refused: { overrides: migrationFee(0, 50), error: 'InvalidMigratorFeePercentage' }, patch: { creatorMigrationFeePercentage: 50n } },
  { label: 'migration option DAMM v1',
    refused: { overrides: { migrationOption: Number(MIGRATION_OPTION_DAMM_V1) }, error: 'DeprecatedMigrationOption' },
    patch: { migrationOption: MIGRATION_OPTION_DAMM_V1 } },
]

async function main() {
  const scenario = loadScenario()
  const chain = liteSvmChain(zpvpPrograms())
  const admin = Keypair.generate()
  await chain.fund(admin.publicKey, 10n ** 16n)
  // one quote mint for every config (a fresh mint: needs the unrestricted build)
  const reference = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: 0, traderLamports: 0n, skipMarket: true })
  const ctx: Ctx = { chain, admin, scenario, quoteMint: reference.quoteMintPk }

  await opens(ctx, { label: 'the default fixture config (dynamic supply, no vesting, partner LP 100% permanently locked)', overrides: {}, expect: {} })
  await opens(ctx, { label: 'the retention preset LP split (creator LP 100% permanently locked)',
    overrides: { partnerPermanentLockedLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 100 },
    expect: { partnerPermanentLockedLp: 0n, creatorPermanentLockedLp: 100n } })
  for (const c of await presetBreakers(ctx, reference)) await rejected(ctx, c)
  for (const c of PATCHED_BREAKERS) await rejectedPatched(ctx, c)
}

main().catch((e) => { console.error(e); process.exit(1) })
