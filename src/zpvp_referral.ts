/**
 * Native Referral (ONC-13) on LiteSVM. A router buy may name a referrer: its quote token account follows the three hook
 * accounts as an optional 4th remaining account, and the router passes it to DBC as `referral_token_account`. DBC pays
 * its referral cut out of the protocol fee, so the buyer's net_into_curve, basis, tokens and later refund are the same
 * with or without a referrer. Sells and auto-exits take exactly the three hook accounts.
 *
 * Markets A and B share one quote mint and the same curve, so the same buy on each starts from the same state: A's
 * buyer names the referrer, B's does not. Every rejection asserts the exact error code (BadHookAccounts 6003) and that
 * no watched account changed.
 *
 * Usage: npx tsx src/zpvp_referral.ts SCENARIOS.json INDEX   (ROUTER_SO=... picks the router binary; the quote is a
 * fresh mint, so this needs the `unrestricted` build)
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import {
  MINT_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createApproveCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Chain, TxResult, liteSvmChain } from './chain'
import {
  BASE_DECIMALS, MarketFixture, ROUTER_ID, Scenario, anchorError, check, createMarketFixture, dbc, disc, eventAuthority,
  meta, must, poolAuthority,
} from './fixture'
import { zpvpPrograms } from './zpvp_e2e'

const TRADER_LAMPORTS = 10n ** 15n
/** Trader 0 buys and exits on both markets; trader 1 (market A only) is the auto-exit subject. */
const BUYER = 0
const EXITER = 1
const TRADERS = 2
const BUY_CAP = 10n ** 9n
const BAD_HOOK_ACCOUNTS = 6003
const badHookAccounts = anchorError(BAD_HOOK_ACCOUNTS, 'BadHookAccounts')
/** DBC fee split: the referral gets 20% of the protocol share of the trading fee. */
const REFERRAL_PERCENT_OF_PROTOCOL = 20n
const QUOTE_DECIMALS = 9
const U64_MAX = 2n ** 64n - 1n
const AUTO_EXIT_DELAY = 60n
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32
const PROGRAM_DATA = 'Program data: '
// BuyEvent (borsh after the 8-byte discriminator): market 8 | user 40 | tokens_out 72 | net_into_curve 80 | basis 88
const BUY_EVENT_NET_INTO_CURVE = 80

type Ctx = {
  chain: Chain; admin: Keypair; A: MarketFixture; B: MarketFixture; amount: bigint
  /** The referrer's wallet and its canonical quote ATA (the referral account a buy names). */
  referrer: Keypair; referrerQuote: PublicKey
}

function loadScenario(): Scenario {
  const [scenarioPath, indexArg] = process.argv.slice(2)
  if (!scenarioPath) throw new Error('usage: zpvp_referral.ts SCENARIOS.json INDEX')
  const index = Number(indexArg ?? 0)
  const scenario: Scenario | undefined = JSON.parse(readFileSync(scenarioPath, 'utf8'))[index]
  if (!scenario) throw new Error(`no scenario at index ${index} in ${scenarioPath}`)
  return scenario
}

/** The three hook accounts followed by `extra` (a referral account, or more). */
const remaining = (m: MarketFixture, ...extra: ReturnType<typeof meta>[]) => [...m.hookAccounts, ...extra]
const withReferral = (m: MarketFixture, account: PublicKey) => remaining(m, meta(account, true))

const ANCHOR_ERROR = /Error Code: \w+\. Error Number: \d+/
const errorDetail = (r: TxResult) =>
  (r.ok ? 'SUCCEEDED (not rejected!)' : r.error.match(ANCHOR_ERROR)?.[0] ?? r.error.replace(/\s+/g, ' ').slice(0, 110))

/** Hex of every watched account: equal before and after means a rejected transaction moved no funds and changed no state. */
const stateOf = (chain: Chain, accounts: PublicKey[]) =>
  Promise.all(accounts.map(async (a) => (await chain.accountData(a))?.toString('hex') ?? 'missing'))

/** Sends, then asserts BadHookAccounts (6003) on the router instruction and that no watched account changed. */
async function rejectedUnchanged(chain: Chain, watched: PublicKey[], send: () => Promise<TxResult>, label: string): Promise<void> {
  const before = await stateOf(chain, watched)
  const r = await send()
  const unchanged = (await stateOf(chain, watched)).every((d, i) => d === before[i])
  const matches = !r.ok && badHookAccounts.test(r.error)
  check(matches && unchanged, `${label} (${BAD_HOOK_ACCOUNTS}), no balance change`, `${unchanged ? '' : 'STATE CHANGED '}${errorDetail(r)}`)
}

/** Accounts a buy, sell or auto-exit of trader `i` on market `m` could move funds or state in, plus `extra`. */
const watchedFor = (m: MarketFixture, i: number, extra: PublicKey[]) => [
  m.positionOf(i), m.market, m.buffer, m.ata[i].quote, m.ata[i].base, m.pool, m.baseVault, m.quoteVault, m.baseMint.publicKey, ...extra,
]

/** BuyEvent.net_into_curve of a router buy, from its `Program data:` log. */
function netIntoCurve(r: TxResult): bigint {
  const tag = createHash('sha256').update('event:BuyEvent').digest().subarray(0, 8)
  const events = (r.ok ? r.logs ?? [] : [])
    .filter((l) => l.startsWith(PROGRAM_DATA))
    .map((l) => Buffer.from(l.slice(PROGRAM_DATA.length), 'base64'))
    .filter((d) => d.subarray(0, 8).equals(tag))
  if (events.length !== 1) throw new Error(`expected one BuyEvent, found ${events.length}`)
  return events[0].readBigUInt64LE(BUY_EVENT_NET_INTO_CURVE)
}

type PoolQuote = { reserve: bigint; protocolFee: bigint; partnerFee: bigint; creatorFee: bigint }

/** Quote reserve and the quote fees DBC has booked for protocol, partner and creator. */
async function poolQuote(chain: Chain, pool: PublicKey): Promise<PoolQuote> {
  const data = await chain.accountData(pool)
  if (!data) throw new Error(`pool ${pool.toBase58()} not found`)
  const s = dbc.coder.accounts.decode('transferHookPool', data).poolState
  const n = (v: { toString(): string }) => BigInt(v.toString())
  return { reserve: n(s.quoteReserve), protocolFee: n(s.protocolQuoteFee), partnerFee: n(s.partnerQuoteFee), creatorFee: n(s.creatorQuoteFee) }
}

const delta = (after: PoolQuote, before: PoolQuote): PoolQuote => ({
  reserve: after.reserve - before.reserve, protocolFee: after.protocolFee - before.protocolFee,
  partnerFee: after.partnerFee - before.partnerFee, creatorFee: after.creatorFee - before.creatorFee,
})

/** A wallet's canonical ATA of `mint` (SPL Token), created by `payer`. */
async function quoteAtaOf(chain: Chain, payer: Keypair, wallet: PublicKey, mint: PublicKey): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_PROGRAM_ID)
  must(await chain.send(payer, [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, wallet, mint, TOKEN_PROGRAM_ID)]),
    `ATA of ${wallet.toBase58()} for mint ${mint.toBase58()}`)
  return ata
}

/** A fresh SPL mint, not the markets' quote. */
async function otherMint(chain: Chain, admin: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate()
  must(await chain.send(admin, [
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey,
      lamports: await chain.rentExempt(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, QUOTE_DECIMALS, admin.publicKey, null),
  ], [mint]), 'other mint')
  return mint.publicKey
}

/** A copy of `source` (an SPL token account of the quote mint) at a fresh address, owned by Token-2022 instead. */
async function token2022Copy(chain: Chain, source: PublicKey): Promise<PublicKey> {
  if (!chain.setAccount) throw new Error(`${chain.name}: cannot write accounts (LiteSVM only)`)
  const data = await chain.accountData(source)
  if (!data) throw new Error(`token account ${source.toBase58()} not found`)
  const copy = Keypair.generate().publicKey
  chain.setAccount(copy, { lamports: await chain.lamports(source), owner: TOKEN_2022_PROGRAM_ID, executable: false, data })
  return copy
}

async function referralBuy(ctx: Ctx): Promise<void> {
  const { chain, A, B, amount, referrerQuote } = ctx
  console.log('-- the same buy with (market A) and without (market B) a referrer')
  const [poolA, poolB] = [await poolQuote(chain, A.pool), await poolQuote(chain, B.pool)]
  const [vaultA, vaultB] = [await A.balanceOf(A.quoteVault), await B.balanceOf(B.quoteVault)]
  const [paidA, paidB] = [await A.balanceOf(A.ata[BUYER].quote), await B.balanceOf(B.ata[BUYER].quote)]
  const referrerBefore = await A.balanceOf(referrerQuote)

  const withRef = await chain.send(A.traders[BUYER], A.buyIxs(BUYER, amount, { hookAccounts: withReferral(A, referrerQuote) }))
  must(withRef, 'market A: buy naming the referrer')
  const without = await chain.send(B.traders[BUYER], B.buyIxs(BUYER, amount))
  must(without, 'market B: the same buy without a referrer')

  const gain = (await A.balanceOf(referrerQuote)) - referrerBefore
  check(gain > 0n, "a buy with a referrer increases the referrer's quote balance", `+${gain}`)

  const [posA, posB] = [await A.readPosition(BUYER), await B.readPosition(BUYER)]
  const [netA, netB] = [netIntoCurve(withRef), netIntoCurve(without)]
  check(posA.tokens > 0n && posA.tokens === posB.tokens && posA.basis === posB.basis && netA === netB,
    'on two identical fresh markets the same buy with and without a referrer records the same basis and the same tokens',
    `tokens ${posA.tokens}/${posB.tokens} basis ${posA.basis}/${posB.basis} net_into_curve ${netA}/${netB}`)
  const [spentA, spentB] = [paidA - (await A.balanceOf(A.ata[BUYER].quote)), paidB - (await B.balanceOf(B.ata[BUYER].quote))]
  check(spentA === amount && spentB === amount, 'both buyers paid exactly amount_in', `${spentA}/${spentB}`)

  const [dA, dB] = [delta(await poolQuote(chain, A.pool), poolA), delta(await poolQuote(chain, B.pool), poolB)]
  check(dA.reserve === dB.reserve && dA.reserve === netA && dA.partnerFee === dB.partnerFee && dA.creatorFee === dB.creatorFee,
    'the quote reserve delta (the basis source) and the partner and creator fees are the same with and without a referrer',
    `reserve +${dA.reserve} partner +${dA.partnerFee} creator +${dA.creatorFee}`)
  check(dB.protocolFee - dA.protocolFee === gain && gain === (dB.protocolFee * REFERRAL_PERCENT_OF_PROTOCOL) / 100n,
    "the referral cut is 20% of DBC's protocol fee and comes out of it", `protocol fee +${dB.protocolFee} without, +${dA.protocolFee} with`)
  const [inA, inB] = [(await A.balanceOf(A.quoteVault)) - vaultA, (await B.balanceOf(B.quoteVault)) - vaultB]
  check(inB === amount && inA === amount - gain, "the referrer's cut leaves the pool's quote vault, nothing else does",
    `vault +${inA} with, +${inB} without`)
}

async function rejectedBuyReferrals(ctx: Ctx): Promise<void> {
  const { chain, admin, A, amount, referrer, referrerQuote } = ctx
  console.log('-- referral accounts a buy may not name')
  const buyWith = (hookAccounts: ReturnType<typeof meta>[]) => () =>
    chain.send(A.traders[BUYER], A.buyIxs(BUYER, amount, { hookAccounts }))
  const rejectBuy = (label: string, account: PublicKey, hookAccounts = withReferral(A, account)) =>
    rejectedUnchanged(chain, watchedFor(A, BUYER, [account, referrerQuote]), buyWith(hookAccounts), label)

  await rejectBuy('a referral account of the wrong mint is rejected', await quoteAtaOf(chain, admin, referrer.publicKey, await otherMint(chain, admin)))
  await rejectBuy('a referral account owned by Token-2022, not the quote token program, is rejected', await token2022Copy(chain, referrerQuote))
  await rejectBuy("the referrer's wallet instead of its token account is rejected", referrer.publicKey)
  await rejectBuy("the pool's quote vault as referral account is rejected", A.quoteVault)
  await rejectBuy("the market's buffer vault as referral account is rejected", A.buffer)
  await rejectBuy('a read-only referral account is rejected', referrerQuote, remaining(A, meta(referrerQuote, false)))
  await rejectBuy('5 remaining accounts are rejected', referrerQuote, remaining(A, meta(referrerQuote, true), meta(A.ata[EXITER].quote, true)))
  await rejectBuy('2 remaining accounts are rejected', referrerQuote, A.hookAccounts.slice(0, 2))
}

/** Sells trader BUYER's whole position on `m`; returns [refund to the owner, buffer change (proceeds - refund)]. */
async function exitAll(chain: Chain, m: MarketFixture): Promise<[bigint, bigint]> {
  const [quote, buffer] = [await m.balanceOf(m.ata[BUYER].quote), await m.balanceOf(m.buffer)]
  must(await chain.send(m.traders[BUYER], [m.sellIx(BUYER, (await m.readPosition(BUYER)).tokens)]), 'exit the whole position')
  return [(await m.balanceOf(m.ata[BUYER].quote)) - quote, (await m.balanceOf(m.buffer)) - buffer]
}

async function laterExit(ctx: Ctx): Promise<void> {
  const { chain, A, B, referrerQuote } = ctx
  console.log('-- a later exit')
  const tokens = (await A.readPosition(BUYER)).tokens
  await rejectedUnchanged(chain, watchedFor(A, BUYER, [referrerQuote]),
    () => chain.send(A.traders[BUYER], [A.sellIx(BUYER, tokens, { hookAccounts: withReferral(A, referrerQuote) })]),
    'a sell with 4 remaining accounts (hooks + referral) is rejected')
  const referrerBefore = await A.balanceOf(referrerQuote)
  const [[refundA, keptA], [refundB, keptB]] = [await exitAll(chain, A), await exitAll(chain, B)]
  check(refundA > 0n && refundA === refundB, 'a later exit refunds the same amount with and without the referrer', `${refundA}/${refundB}`)
  check(keptA === keptB, 'and leaves the same amount (proceeds - refund) in the buffer', `+${keptA}/+${keptB}`)
  check((await A.balanceOf(referrerQuote)) === referrerBefore, 'the exit pays the referrer nothing')
  const [posA, posB] = [await A.readPosition(BUYER), await B.readPosition(BUYER)]
  check(posA.tokens === 0n && posA.basis === 0n && posB.tokens === 0n && posB.basis === 0n, 'both positions are empty after the exit')
}

/**
 * auto_exit(). Accounts: cranker (signer), owner, market, position, owner_quote, owner_base, buffer_vault, then the DBC
 * swap accounts as in buy/sell, system program, and `hookAccounts` as remaining accounts.
 */
function autoExitIx(m: MarketFixture, cranker: PublicKey, owner: number, hookAccounts: ReturnType<typeof meta>[]) {
  return new TransactionInstruction({
    programId: ROUTER_ID, data: disc('auto_exit'),
    keys: [
      meta(cranker, false, true), meta(m.traders[owner].publicKey), meta(m.market, true), meta(m.positionOf(owner), true),
      meta(m.ata[owner].quote, true), meta(m.ata[owner].base, true), meta(m.buffer, true),
      meta(poolAuthority), meta(m.config.publicKey), meta(m.pool, true), meta(m.baseVault, true), meta(m.quoteVault, true),
      meta(m.baseMint.publicKey, true), meta(m.quoteMintPk), meta(TOKEN_2022_PROGRAM_ID), meta(m.quoteTokenProgram),
      meta(eventAuthority), meta(DYNAMIC_BONDING_CURVE_PROGRAM_ID), meta(SystemProgram.programId), ...hookAccounts,
    ],
  })
}

function setAutoExitIx(m: MarketFixture, owner: number, deadline: bigint) {
  const arg = Buffer.alloc(8)
  arg.writeBigInt64LE(deadline)
  return new TransactionInstruction({
    programId: ROUTER_ID, data: Buffer.concat([disc('set_auto_exit'), arg]),
    keys: [meta(m.traders[owner].publicKey, false, true), meta(m.market), meta(m.positionOf(owner), true)],
  })
}

async function clockNow(chain: Chain): Promise<bigint> {
  const data = await chain.accountData(SYSVAR_CLOCK_PUBKEY)
  if (!data) throw new Error('clock sysvar not found')
  return data.readBigInt64LE(CLOCK_UNIX_TIMESTAMP_OFFSET)
}

async function autoExitTakesNoReferral(ctx: Ctx): Promise<void> {
  const { chain, admin, A, amount, referrerQuote } = ctx
  console.log('-- auto_exit')
  if (!chain.setClock) throw new Error(`${chain.name}: cannot warp the clock (LiteSVM only)`)
  const owner = A.traders[EXITER]
  must(await chain.send(owner, A.buyIxs(EXITER, amount)), 'auto-exit subject buys')
  const deadline = (await clockNow(chain)) + AUTO_EXIT_DELAY
  must(await chain.send(owner, [
    createApproveCheckedInstruction(A.ata[EXITER].base, A.baseMint.publicKey, A.market, owner.publicKey, U64_MAX, BASE_DECIMALS, [], TOKEN_2022_PROGRAM_ID),
    setAutoExitIx(A, EXITER, deadline),
  ]), 'approve the market as delegate and set the auto-exit deadline')
  chain.setClock(deadline)
  await rejectedUnchanged(chain, watchedFor(A, EXITER, [referrerQuote]),
    () => chain.send(admin, [autoExitIx(A, admin.publicKey, EXITER, withReferral(A, referrerQuote))]),
    'an auto_exit with 4 remaining accounts (hooks + referral) is rejected')
  const r = await chain.send(admin, [autoExitIx(A, admin.publicKey, EXITER, A.hookAccounts)])
  check(r.ok && (await A.readPosition(EXITER)).tokens === 0n, 'the same auto_exit with the 3 hook accounts exits the position', r.ok ? '' : errorDetail(r))
}

async function main() {
  const scenario = loadScenario()
  const chain = liteSvmChain(zpvpPrograms())
  const admin = Keypair.generate()
  await chain.fund(admin.publicKey, 10n ** 16n)
  const fixture = { wsol: false, traderCount: TRADERS, traderLamports: TRADER_LAMPORTS }
  const A = await createMarketFixture(chain, admin, scenario, fixture)
  const B = await createMarketFixture(chain, admin, scenario, { ...fixture, quoteMint: A.quoteMintPk })
  const referrer = Keypair.generate()
  await chain.fund(referrer.publicKey, TRADER_LAMPORTS)
  const referrerQuote = await quoteAtaOf(chain, admin, referrer.publicKey, A.quoteMintPk)
  const threshold = BigInt(scenario.migration_quote_threshold)
  const amount = threshold / 20n < BUY_CAP ? threshold / 20n : BUY_CAP
  const ctx: Ctx = { chain, admin, A, B, amount, referrer, referrerQuote }

  await referralBuy(ctx)
  await rejectedBuyReferrals(ctx)
  await laterExit(ctx)
  await autoExitTakesNoReferral(ctx)
}

main().catch((e) => { console.error(e); process.exit(1) })
