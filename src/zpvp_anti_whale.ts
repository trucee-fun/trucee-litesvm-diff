/**
 * Anti-Whale cap (ONC-04) on LiteSVM: router `buy` rejects (6022 PositionCapExceeded) any buy that would leave the
 * buyer's position above ANTI_WHALE_BPS = 20% of the DBC config's swap_base_amount. The cap is a program constant, so
 * a curve needs at least 5 positions to graduate; here 6 traders graduate one, each at or below the cap.
 *
 * "Up to the cap" is found exactly with a probe: the transaction [buy(amount), unknown router instruction] always
 * fails, so nothing commits, and the failing instruction's index tells whether buy(amount) alone passes the cap.
 * Every rejection asserts the exact code and message and that no watched account changed.
 *
 * Usage: npx tsx src/zpvp_anti_whale.ts SCENARIOS.json INDEX   (ROUTER_SO=... picks the router binary; the quote is a
 * fresh mint, so this needs the `unrestricted` build)
 */
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { Chain, TxResult, liteSvmChain } from './chain'
import { MarketFixture, POOL_QUOTE_RESERVE_OFFSET, ROUTER_ID, Scenario, anchorError, check, createMarketFixture, must } from './fixture'
import { ANTI_WHALE_BPS, BPS, GRADUATION_CHUNKS, antiWhaleCap, leastHeld, spreadBuys, swapBaseAmountOf, zpvpPrograms } from './zpvp_e2e'

const TRADERS = 6
const TRADER_LAMPORTS = 10n ** 15n
/** Buys up to the cap, exits half, buys back up to the cap, then tries the graduating buy. */
const WHALE = 0
/** Its very first buy is above the cap. */
const LATE = TRADERS - 1
const POSITION_CAP_EXCEEDED = 6022
const capExceeded = anchorError(POSITION_CAP_EXCEEDED, 'PositionCapExceeded')
const CAP_MESSAGE = /Error Message: Buy would exceed the anti-whale cap \(20% of curve supply\)/
/** Anchor's error for an instruction discriminator the program does not have. */
const probeAborted = anchorError(101, 'InstructionFallbackNotFound', 1)
const abortIx = new TransactionInstruction({ programId: ROUTER_ID, keys: [], data: Buffer.alloc(8) })
/** A buy "up to the cap" leaves the position within cap / UP_TO_CAP_TOLERANCE of the cap. */
const UP_TO_CAP_TOLERANCE = 1_000n
/** The graduation spread stops while at most this many chunks of quote are missing from the threshold. */
const NEAR_END_CHUNKS = 3n

type Ctx = { chain: Chain; m: MarketFixture; threshold: bigint; chunk: bigint; cap: bigint; swapBaseAmount: bigint }

function loadScenario(): Scenario {
  const [scenarioPath, indexArg] = process.argv.slice(2)
  if (!scenarioPath) throw new Error('usage: zpvp_anti_whale.ts SCENARIOS.json INDEX')
  const index = Number(indexArg ?? 0)
  const scenario: Scenario | undefined = JSON.parse(readFileSync(scenarioPath, 'utf8'))[index]
  if (!scenario) throw new Error(`no scenario at index ${index} in ${scenarioPath}`)
  return scenario
}

const buy = ({ chain, m }: Ctx, i: number, amount: bigint) => chain.send(m.traders[i], m.buyIxs(i, amount))
const tokensOf = async ({ m }: Ctx, i: number) => (await m.readPosition(i)).tokens
const pct = (tokens: bigint, swapBaseAmount: bigint) => `${(Number((tokens * 10n ** 6n) / swapBaseAmount) / 10 ** 4).toFixed(4)}%`

/** Accounts a buy by trader `i` could move funds or state in. */
const watchedFor = ({ m }: Ctx, i: number): PublicKey[] =>
  [m.positionOf(i), m.market, m.buffer, m.ata[i].quote, m.ata[i].base, m.pool, m.baseVault, m.quoteVault, m.baseMint.publicKey]

/** Hex of every watched account: equal before and after means a rejected transaction moved no funds and changed no state. */
const stateOf = (chain: Chain, accounts: PublicKey[]) =>
  Promise.all(accounts.map(async (a) => (await chain.accountData(a))?.toString('hex') ?? 'missing'))

const errorDetail = (r: TxResult) => (r.ok ? 'SUCCEEDED (cap not enforced!)' : r.error.replace(/\s+/g, ' ').slice(0, 110))

/** Sends trader `i`'s buy, then asserts 6022 with its message and that no watched account changed. */
async function rejectedUnchanged(ctx: Ctx, i: number, amount: bigint, label: string): Promise<void> {
  const watched = watchedFor(ctx, i)
  const before = await stateOf(ctx.chain, watched)
  const r = await buy(ctx, i, amount)
  const unchanged = (await stateOf(ctx.chain, watched)).every((d, k) => d === before[k])
  const matches = !r.ok && capExceeded.test(r.error) && CAP_MESSAGE.test(r.error)
  check(matches && unchanged, `${label} (${POSITION_CAP_EXCEEDED}), no balance change`,
    `amount_in=${amount} ${unchanged ? '' : 'STATE CHANGED '}${errorDetail(r)}`)
}

/** Whether trader `i`'s buy of `amount` would pass the cap now, without committing anything. */
async function wouldAccept(ctx: Ctx, i: number, amount: bigint): Promise<boolean> {
  const { chain, m } = ctx
  const r = await chain.send(m.traders[i], [...m.buyIxs(i, amount), abortIx])
  if (r.ok) throw new Error(`probe buy(${amount}) by trader ${i} committed`)
  if (capExceeded.test(r.error)) return false
  if (probeAborted.test(r.error)) return true
  throw new Error(`probe buy(${amount}) by trader ${i}: unexpected ${r.error}`)
}

/** The largest amount_in trader `i` can buy now without passing the cap (binary search over probes). */
async function largestAcceptedBuy(ctx: Ctx, i: number): Promise<bigint> {
  let [lo, hi] = [ctx.chunk / 10n, ctx.threshold]
  if (!(await wouldAccept(ctx, i, lo)) || (await wouldAccept(ctx, i, hi))) {
    throw new Error(`trader ${i}: expected buy(${lo}) to pass and buy(${hi}) to exceed the cap`)
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n
    if (await wouldAccept(ctx, i, mid)) lo = mid
    else hi = mid
  }
  return lo
}

/** Buys the largest amount that keeps trader `i` within the cap; returns [amount_in, position tokens after]. */
async function buyUpToCap(ctx: Ctx, i: number, what: string): Promise<[bigint, bigint]> {
  const amount = await largestAcceptedBuy(ctx, i)
  await rejectedUnchanged(ctx, i, amount + 1n, `${what}: one lamport more than the largest allowed buy is rejected`)
  must(await buy(ctx, i, amount), `${what}: buy up to the cap`)
  return [amount, await tokensOf(ctx, i)]
}

const isUpToCap = (tokens: bigint, cap: bigint) => tokens <= cap && (cap - tokens) * UP_TO_CAP_TOLERANCE <= cap

async function firstBuyAboveCap(ctx: Ctx): Promise<void> {
  console.log('-- a first buy above the cap')
  await rejectedUnchanged(ctx, LATE, ctx.threshold, 'a first buy of the whole curve is rejected')
  check((await ctx.chain.accountData(ctx.m.positionOf(LATE))) === null, 'the rejected first buy created no position account')
}

async function upToTheCap(ctx: Ctx): Promise<void> {
  const { cap, chunk, swapBaseAmount } = ctx
  console.log('-- up to the cap')
  const [amount, tokens] = await buyUpToCap(ctx, WHALE, 'whale')
  check(isUpToCap(tokens, cap), 'a buy up to the cap is accepted',
    `amount_in=${amount} position=${tokens} (${pct(tokens, swapBaseAmount)}) cap=${cap} gap=${cap - tokens}`)
  await rejectedUnchanged(ctx, WHALE, chunk, 'a buy that pushes a position over the cap is rejected')
}

async function buyBackAfterPartialExit(ctx: Ctx): Promise<void> {
  const { chain, m, cap, chunk, swapBaseAmount } = ctx
  console.log('-- after a partial exit')
  const held = await tokensOf(ctx, WHALE)
  const sold = held / 2n
  must(await chain.send(m.traders[WHALE], [m.sellIx(WHALE, sold)]), 'whale exits half at cost')
  const afterExit = await tokensOf(ctx, WHALE)
  const [amount, tokens] = await buyUpToCap(ctx, WHALE, 'whale after exit')
  check(afterExit === held - sold && tokens > afterExit && isUpToCap(tokens, cap),
    'after a partial exit the same trader can buy back up to the cap',
    `sold=${sold} position ${afterExit} -> ${tokens} (${pct(tokens, swapBaseAmount)}) amount_in=${amount} gap=${cap - tokens}`)
  await rejectedUnchanged(ctx, WHALE, chunk, 'after the buy-back the cap applies again')
}

async function graduation(ctx: Ctx): Promise<void> {
  const { chain, m, threshold, chunk, cap, swapBaseAmount } = ctx
  console.log('-- graduation')
  const reserve = async () => (await chain.accountData(m.pool))!.readBigUInt64LE(POOL_QUOTE_RESERVE_OFFSET)
  const others = m.traders.map((_, i) => i).filter((i) => i !== WHALE)
  const nearEnd = async () => (await reserve()) + NEAR_END_CHUNKS * chunk >= threshold
  const spread = await spreadBuys(m, threshold, { who: others, done: nearEnd })
  if (!(await nearEnd()) || (await m.curveDone())) throw new Error(`spread stopped after ${spread} buys away from the end of the curve`)
  console.log(`      ${spread} spread buys of ${chunk}; quote reserve ${await reserve()} of ${threshold}`)

  // a partial-fill buy of the whole threshold takes every token left, which would push the whale over the cap
  await rejectedUnchanged(ctx, WHALE, threshold, 'a graduating partial-fill buy that would exceed the cap is rejected')
  const smallest = others[leastHeld(await Promise.all(others.map((i) => tokensOf(ctx, i))))]
  must(await buy(ctx, smallest, threshold), `graduating buy by trader ${smallest}`)
  const tokens = await Promise.all(m.traders.map((_, i) => tokensOf(ctx, i)))
  check((await m.curveDone()) && tokens[smallest] <= cap,
    'the same partial-fill buy by the smallest holder completes the curve within the cap',
    `trader ${smallest}: ${tokens[smallest]} (${pct(tokens[smallest], swapBaseAmount)})`)
  const largest = tokens.reduce((a, b) => (b > a ? b : a), 0n)
  check((await m.curveDone()) && tokens.every((x) => x > 0n && x <= cap),
    `a curve graduates with ${TRADERS} traders each at or below the cap`,
    `largest=${largest} (${pct(largest, swapBaseAmount)}) cap=${cap} (${ANTI_WHALE_BPS * 100n / BPS}%) sold=${tokens.reduce((a, b) => a + b, 0n)}`)
}

async function main() {
  const scenario = loadScenario()
  const chain = liteSvmChain(zpvpPrograms())
  const admin = Keypair.generate()
  await chain.fund(admin.publicKey, 10n ** 16n)
  const m = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: TRADERS, traderLamports: TRADER_LAMPORTS })
  const threshold = BigInt(scenario.migration_quote_threshold)
  const swapBaseAmount = await swapBaseAmountOf(chain, m.config.publicKey)
  const ctx: Ctx = { chain, m, threshold, chunk: threshold / GRADUATION_CHUNKS, cap: antiWhaleCap(swapBaseAmount), swapBaseAmount }
  console.log(`      swap_base_amount=${swapBaseAmount} cap=${ctx.cap} threshold=${threshold}`)

  await firstBuyAboveCap(ctx)
  await upToTheCap(ctx)
  await buyBackAfterPartialExit(ctx)
  await graduation(ctx)
}

main().catch((e) => { console.error(e); process.exit(1) })
