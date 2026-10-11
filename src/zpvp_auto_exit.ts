/**
 * Auto-Exit, part 1 (ONC-11): a position owner stores or clears `Position.auto_exit_deadline` via
 * `set_auto_exit(deadline)`. Covers the happy paths, every rejection path with its exact error code, and that
 * buys and the setter leave each other's fields alone.
 * The curve is graduated by small buys spread over TRADERS wallets (the least-held trader buys next), so no
 * position exceeds the Anti-Whale cap (20% of the config's swap_base_amount, ONC-04) at any point.
 *
 * Usage: npx tsx src/zpvp_auto_exit.ts SCENARIOS.json INDEX   (ROUTER_SO=... picks the router binary)
 */
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionInstruction } from '@solana/web3.js'
import { Chain, TxResult, liteSvmChain } from './chain'
import { ROUTER_ID, Scenario, check, createMarketFixture, disc, meta, must } from './fixture'
import { zpvpPrograms } from './zpvp_e2e'

const TRADERS = 8
const TRADER_LAMPORTS = 10n ** 15n
const SEED_BUY = 10n ** 8n
// Position layout (borsh): disc 8 | owner 32 | market 32 | tokens u64 @72 | basis u64 @80 | bump u8 @88 | auto_exit_deadline i64 @89
const POSITION_LEN = 97
const POSITION_DEADLINE_OFFSET = 89
const CONFIG_SWAP_BASE_AMOUNT_OFFSET = 256 // ConfigWithTransferHook
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32
const ANTI_WHALE_BPS = 2_000n
const BPS = 10_000n
const GRADUATION_CHUNKS = 100n // graduation buy size = threshold / GRADUATION_CHUNKS, always by the least-held trader
const MAX_GRADUATION_BUYS = 400
const ONE_DAY = 86_400n
const I64_MIN = -(2n ** 63n)

const ERR = {
  constraintSeeds: 2006,
  accountNotSigner: 3010,
  accountNotInitialized: 3012,
  alreadyFinalized: 6010,
  autoExitDeadlineInPast: 6019,
} as const

const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b }

type SetAutoExitAccounts = { owner: PublicKey; market: PublicKey; position: PublicKey; ownerSigns?: boolean }

/** set_auto_exit(deadline: i64). Accounts: owner (signer), market, position (mut). */
function setAutoExitIx({ owner, market, position, ownerSigns = true }: SetAutoExitAccounts, deadline: bigint) {
  return new TransactionInstruction({
    programId: ROUTER_ID, data: Buffer.concat([disc('set_auto_exit'), i64(deadline)]),
    keys: [meta(owner, false, ownerSigns), meta(market), meta(position, true)],
  })
}

/** Index of the trader holding the fewest tokens: graduation buys go there so positions stay balanced. */
function leastHeld(tokens: bigint[]): number {
  return tokens.reduce((best, x, i) => (x < tokens[best] ? i : best), 0)
}

function rejectedWith(r: TxResult, code: number, label: string): void {
  const ok = !r.ok && new RegExp(`code: ${code}\\b`).test(r.error)
  check(ok, `${label} (${code})`, r.ok ? 'SUCCEEDED (vulnerable!)' : r.error.replace(/\s+/g, ' ').slice(0, 110))
}

async function accountBytes(chain: Chain, address: PublicKey, what: string): Promise<Buffer> {
  const data = await chain.accountData(address)
  if (!data) throw new Error(`${what}: account ${address.toBase58()} not found`)
  return data
}

async function clockUnixTimestamp(chain: Chain): Promise<bigint> {
  return (await accountBytes(chain, SYSVAR_CLOCK_PUBKEY, 'clock sysvar')).readBigInt64LE(CLOCK_UNIX_TIMESTAMP_OFFSET)
}

function loadScenario(): Scenario {
  const [scenarioPath, indexArg] = process.argv.slice(2)
  if (!scenarioPath) throw new Error('usage: zpvp_auto_exit.ts SCENARIOS.json INDEX')
  const index = Number(indexArg ?? 0)
  const scenario: Scenario | undefined = JSON.parse(readFileSync(scenarioPath, 'utf8'))[index]
  if (!scenario) throw new Error(`no scenario at index ${index} in ${scenarioPath}`)
  return scenario
}

async function main() {
  const scenario = loadScenario()
  const chain = liteSvmChain(zpvpPrograms())
  const admin = Keypair.generate()
  await chain.fund(admin.publicKey, 10n ** 16n)

  // A is the market under test; B shares A's quote mint so its accounts can be smuggled into A's instructions
  const A = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: TRADERS, traderLamports: TRADER_LAMPORTS })
  const B = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: 1, traderLamports: TRADER_LAMPORTS, quoteMint: A.quoteMintPk })
  const t = A.traders
  const own = (i: number): SetAutoExitAccounts => ({ owner: t[i].publicKey, market: A.market, position: A.positionOf(i) })
  const setAutoExit = (signer: Keypair, accounts: SetAutoExitAccounts, deadline: bigint) =>
    chain.send(signer, [setAutoExitIx(accounts, deadline)])
  const positionBytes = (position: PublicKey) => accountBytes(chain, position, 'position')
  const deadlineOf = async (position: PublicKey) => (await positionBytes(position)).readBigInt64LE(POSITION_DEADLINE_OFFSET)

  must(await chain.send(t[0], A.buyIxs(0, SEED_BUY)), 'A buy 0')
  must(await chain.send(t[1], A.buyIxs(1, SEED_BUY)), 'A buy 1')
  must(await chain.send(B.traders[0], B.buyIxs(0, SEED_BUY)), 'B buy 0')
  const now = await clockUnixTimestamp(chain)
  const future = now + ONE_DAY

  console.log('-- owner sets and clears')
  const pos0 = A.positionOf(0)
  const fresh = await positionBytes(pos0)
  check(fresh.length === POSITION_LEN && fresh.readBigInt64LE(POSITION_DEADLINE_OFFSET) === 0n,
    'a position created by buy is 97 bytes with auto-exit disabled (0)', `len=${fresh.length}`)
  must(await setAutoExit(t[0], own(0), future), 'set future deadline')
  const afterSet = await positionBytes(pos0)
  check(afterSet.readBigInt64LE(POSITION_DEADLINE_OFFSET) === future,
    'owner sets a future deadline (position bytes 89..97 == deadline)', `deadline=${future}`)
  check(afterSet.subarray(0, POSITION_DEADLINE_OFFSET).equals(fresh.subarray(0, POSITION_DEADLINE_OFFSET)),
    'set does not change tokens@72 or basis@80 (bytes 0..89 untouched)',
    `tokens=${afterSet.readBigUInt64LE(72)} basis=${afterSet.readBigUInt64LE(80)}`)
  must(await setAutoExit(t[0], own(0), future + ONE_DAY), 'move deadline')
  check((await deadlineOf(pos0)) === future + ONE_DAY, 'owner moves an existing deadline')
  must(await setAutoExit(t[0], own(0), 0n), 'clear deadline')
  check((await deadlineOf(pos0)) === 0n, 'owner clears it with 0')

  console.log('-- buys keep the deadline')
  const pos1 = A.positionOf(1)
  must(await setAutoExit(t[1], own(1), future), 'set deadline on position 1')
  const tokensBefore = (await A.readPosition(1)).tokens
  must(await chain.send(t[1], A.buyIxs(1, SEED_BUY)), 'A buy 1 after set')
  check((await deadlineOf(pos1)) === future && (await A.readPosition(1)).tokens > tokensBefore,
    'a buy after set keeps the deadline', `deadline=${await deadlineOf(pos1)}`)

  console.log('-- rejections')
  must(await setAutoExit(t[0], own(0), future), 'reset deadline on position 0')
  rejectedWith(await setAutoExit(t[0], own(0), now - 1n), ERR.autoExitDeadlineInPast, 'past deadline rejected')
  rejectedWith(await setAutoExit(t[0], own(0), I64_MIN), ERR.autoExitDeadlineInPast, 'i64::MIN deadline rejected')
  rejectedWith(await setAutoExit(t[1], { ...own(0), owner: t[1].publicKey }, future + 1n), ERR.constraintSeeds,
    "non-owner signer rejected (signs as owner of someone else's position)")
  rejectedWith(await chain.send(t[1], [setAutoExitIx({ ...own(0), ownerSigns: false }, future + 1n)]), ERR.accountNotSigner,
    "owner key without the owner's signature rejected")
  rejectedWith(await setAutoExit(t[0], { ...own(0), position: pos1 }, future + 1n), ERR.constraintSeeds,
    "another owner's position rejected")
  rejectedWith(await setAutoExit(B.traders[0], { owner: B.traders[0].publicKey, market: A.market, position: B.positionOf(0) },
    future + 1n), ERR.constraintSeeds, 'position of market B with market A rejected')
  rejectedWith(await setAutoExit(t[0], { ...own(0), market: B.market }, future + 1n), ERR.constraintSeeds,
    'position of market A with market B rejected')
  rejectedWith(await setAutoExit(t[5], own(5), future), ERR.accountNotInitialized, 'wallet without a position rejected')
  check((await deadlineOf(pos0)) === future && (await deadlineOf(pos1)) === future
    && (await deadlineOf(B.positionOf(0))) === 0n, 'deadlines untouched by all rejected attempts')

  console.log('-- after finalize')
  const threshold = BigInt(scenario.migration_quote_threshold)
  const chunk = threshold / GRADUATION_CHUNKS
  const positionTokens = async () => (await Promise.all(t.map((_, i) => A.readPosition(i)))).map((p) => p.tokens)
  let buys = 0
  for (; buys < MAX_GRADUATION_BUYS && !(await A.curveDone()); buys++) {
    const i = leastHeld(await positionTokens())
    const r = await chain.send(t[i], A.buyIxs(i, chunk))
    if (!r.ok && !(await A.curveDone())) throw new Error(`graduation buy ${buys} by trader ${i} failed: ${r.error}`)
  }
  check(await A.curveDone(), 'curve A completed', `${TRADERS} traders, ${buys} buys of ${chunk}`)
  const swapBaseAmount = (await accountBytes(chain, A.config.publicKey, 'config A')).readBigUInt64LE(CONFIG_SWAP_BASE_AMOUNT_OFFSET)
  const tokens = await positionTokens()
  const largest = tokens.reduce((a, b) => (b > a ? b : a), 0n)
  const sold = tokens.reduce((a, b) => a + b, 0n)
  const cap = (swapBaseAmount * ANTI_WHALE_BPS) / BPS
  check(tokens.every((x) => x > 0n) && sold <= swapBaseAmount && largest <= cap,
    'graduation spread: no position above 20% of swap_base_amount (Anti-Whale)',
    `largest=${largest} (${(largest * BPS) / swapBaseAmount} bps) cap=${cap} sold=${sold}`)
  check((await deadlineOf(pos0)) === future && (await deadlineOf(pos1)) === future, 'graduation buys keep the deadlines')
  must(await chain.send(admin, [A.finalizeIx()]), 'finalize A')
  rejectedWith(await setAutoExit(t[0], own(0), future + 1n), ERR.alreadyFinalized, 'set on a finalized market rejected')
  rejectedWith(await setAutoExit(t[0], own(0), 0n), ERR.alreadyFinalized, 'clear on a finalized market rejected')
  check((await deadlineOf(pos0)) === future, 'deadline untouched after finalize')
}

main().catch((e) => { console.error(e); process.exit(1) })
