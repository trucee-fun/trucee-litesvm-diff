/**
 * Auto-Exit on LiteSVM.
 * - ONC-11: a position owner stores or clears `Position.auto_exit_deadline` via `set_auto_exit(deadline)`; buys and
 *   the setter leave each other's fields alone.
 * - ONC-12: once the deadline has passed and while the curve is live, anyone may `auto_exit` the whole position at
 *   cost: the market PDA sells the owner's tokens as their token delegate and the refund lands in the owner's
 *   canonical quote ATA. The clock is warped with `Chain.setClock`.
 * - ONC-19: a sell that empties a position clears its deadline (a re-bought position cannot be auto-exited on the old
 *   one); non-ATA owner accounts, another market's buffer or pool, and a victim delegated to market A cranked through
 *   market B's accounts are all rejected.
 * Every rejection asserts its exact error code; auto_exit rejections also assert that no account changed.
 * The curve is graduated by small buys spread over TRADERS wallets (the least-held trader buys next), so no
 * position exceeds the Anti-Whale cap (20% of the config's swap_base_amount, ONC-04) at any point.
 *
 * Usage: npx tsx src/zpvp_auto_exit.ts SCENARIOS.json INDEX   (ROUTER_SO=... picks the router binary)
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID, createApproveCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction, createRevokeInstruction, getAccountLenForMint, getAssociatedTokenAddressSync, unpackMint,
} from '@solana/spl-token'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Chain, TxResult, liteSvmChain } from './chain'
import {
  BASE_DECIMALS, MARKET_BASIS_SNAPSHOT_OFFSET, MARKET_SURPLUS_SNAPSHOT_OFFSET, MARKET_TOTAL_BASIS_OFFSET, MarketFixture,
  ROUTER_ID, Scenario, check, createMarketFixture, disc, eventAuthority, meta, must, pda, poolAuthority,
} from './fixture'
import { zpvpPrograms } from './zpvp_e2e'

const TRADERS = 8
const TRADER_LAMPORTS = 10n ** 15n
const SEED_BUY = 10n ** 8n
// Position layout (borsh): disc 8 | owner 32 | market 32 | tokens u64 @72 | basis u64 @80 | bump u8 @88 | auto_exit_deadline i64 @89
const POSITION_LEN = 97
const POSITION_TOKENS_OFFSET = 72
const POSITION_BASIS_OFFSET = 80
const POSITION_DEADLINE_OFFSET = 89
const MARKET_FEE_OFFSET = 232
const CONFIG_SWAP_BASE_AMOUNT_OFFSET = 256 // ConfigWithTransferHook
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32
const ANTI_WHALE_BPS = 2_000n
const BPS = 10_000n
const GRADUATION_CHUNKS = 100n // graduation buy size = threshold / GRADUATION_CHUNKS, always by the least-held trader
const MAX_GRADUATION_BUYS = 400
const ONE_DAY = 86_400n
const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n
const U64_MAX = 2n ** 64n - 1n
// zpvp_router math.rs
const FEE_DENOMINATOR = 1_000_000_000n
const HAIRCUT_PER_EXIT = 2n
const TX_FEE = 5_000n // LiteSVM: 5000 lamports per signature
const PROGRAM_DATA = 'Program data: '
// Event payloads (borsh after the 8-byte discriminator): market @8, user @40, then the event's own fields
const EVENT_MARKET = 8
const EVENT_USER = 40
const SELL_TOKENS = 72 // SellEvent: tokens, basis_part, proceeds, refund (u64)
const SELL_BASIS_PART = 80
const SELL_PROCEEDS = 88
const SELL_REFUND = 96
const AUTO_EXIT_CRANKER = 72 // AutoExitEvent: cranker (pubkey)
const AUTO_EXIT_SET_DEADLINE = 72 // AutoExitSetEvent: deadline (i64)
const TOKEN_DELEGATE_OFFSET = 72 // SPL token account: delegate COption<Pubkey> (u32 tag, then the key)
// auto_exit test roles (trader indexes): EXITER is exited by CRANKER; IDLE keeps auto-exit disabled
const EXITER = 2
const IDLE = 3
const LATE_BUYER = 4
const VICTIM = 5 // ONC-19 cross-market victim (holds no position before autoExitSuite)
const CRANKER = 6
const FULL_SELLER = 7 // ONC-19: sells the whole position after setting a deadline, then buys again

const ERR = {
  constraintHasOne: 2001,
  constraintSeeds: 2006,
  constraintAssociated: 2009,
  constraintTokenOwner: 2015,
  accountNotSigner: 3010,
  accountNotInitialized: 3012,
  invalidExitAmount: 6007,
  alreadyFinalized: 6010,
  autoExitDeadlineInPast: 6019,
  autoExitNotDue: 6020,
  autoExitCurveComplete: 6021,
} as const
// Token-2022 errors raised inside DBC's transfer of the owner's tokens (authority = market PDA)
const TOKEN_ERR = { insufficientFunds: 1, ownerMismatch: 4 } as const
const tokenProgramFailed = (code: number) =>
  new RegExp(`${TOKEN_2022_PROGRAM_ID.toBase58()} failed: custom program error: 0x${code.toString(16)}\\b`)

const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b }

type SetAutoExitAccounts = { owner: PublicKey; market: PublicKey; position: PublicKey; ownerSigns?: boolean }

/** set_auto_exit(deadline: i64). Accounts: owner (signer), market, position (mut). */
function setAutoExitIx({ owner, market, position, ownerSigns = true }: SetAutoExitAccounts, deadline: bigint) {
  return new TransactionInstruction({
    programId: ROUTER_ID, data: Buffer.concat([disc('set_auto_exit'), i64(deadline)]),
    keys: [meta(owner, false, ownerSigns), meta(market), meta(position, true)],
  })
}

type AutoExitAccounts = {
  cranker: PublicKey; owner: PublicKey; position: PublicKey; ownerQuote: PublicKey; ownerBase: PublicKey
  /** Market m's own unless overridden (to smuggle in another market's) */
  buffer?: PublicKey; pool?: PublicKey
}

/**
 * auto_exit(). Accounts: cranker (signer), owner, market, position, owner_quote, owner_base, buffer_vault, then the
 * DBC swap accounts as in buy/sell, system program, and the hook accounts as remaining accounts.
 */
function autoExitIx(m: MarketFixture, a: AutoExitAccounts) {
  return new TransactionInstruction({
    programId: ROUTER_ID, data: disc('auto_exit'),
    keys: [
      meta(a.cranker, false, true), meta(a.owner), meta(m.market, true), meta(a.position, true),
      meta(a.ownerQuote, true), meta(a.ownerBase, true), meta(a.buffer ?? m.buffer, true),
      meta(poolAuthority), meta(m.config.publicKey), meta(a.pool ?? m.pool, true), meta(m.baseVault, true), meta(m.quoteVault, true),
      meta(m.baseMint.publicKey, true), meta(m.quoteMintPk), meta(TOKEN_2022_PROGRAM_ID), meta(m.quoteTokenProgram),
      meta(eventAuthority), meta(DYNAMIC_BONDING_CURVE_PROGRAM_ID), meta(SystemProgram.programId), ...m.hookAccounts,
    ],
  })
}

/** Default auto_exit accounts for trader `owner`'s position, cranked by `cranker`. */
const exitOf = (m: MarketFixture, owner: number, cranker: PublicKey): AutoExitAccounts => ({
  cranker, owner: m.traders[owner].publicKey, position: m.positionOf(owner), ownerQuote: m.ata[owner].quote, ownerBase: m.ata[owner].base,
})

/** Accounts an auto_exit of trader `owner`'s position could move funds or state in. */
const exitWatched = (m: MarketFixture, owner: number) =>
  [m.positionOf(owner), m.market, m.buffer, m.ata[owner].quote, m.ata[owner].base, m.pool, m.baseVault, m.quoteVault]

/** Trader `i` approves the market PDA as delegate of their base ATA for `amount` (the SDK uses u64::MAX). */
const approveMarketIx = (m: MarketFixture, i: number, amount: bigint) => createApproveCheckedInstruction(
  m.ata[i].base, m.baseMint.publicKey, m.market, m.traders[i].publicKey, amount, BASE_DECIMALS, [], TOKEN_2022_PROGRAM_ID)
const revokeIx = (m: MarketFixture, i: number) => createRevokeInstruction(m.ata[i].base, m.traders[i].publicKey, [], TOKEN_2022_PROGRAM_ID)
const positionPda = (market: PublicKey, owner: PublicKey) => pda([Buffer.from('position'), market.toBuffer(), owner.toBuffer()], ROUTER_ID)

type BuyAccounts = { position: PublicKey; userQuote: PublicKey; userBase: PublicKey }

/** Router buy on market `m` by `wallet`, which is not one of m's fixture traders: m's buy with the user key swapped in. */
function foreignBuyIx(m: MarketFixture, wallet: PublicKey, accounts: BuyAccounts, amount: bigint) {
  const [ix] = m.buyIxs(0, amount, accounts, 0n)
  return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: [meta(wallet, true, true), ...ix.keys.slice(1)] })
}

/** refund_for(basis, fee) = basis - ceil(basis * fee / 1e9) - 2, floored at zero (math.rs). */
function refundFor(basis: bigint, fee: bigint): bigint {
  const feeAtCost = (basis * fee + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR
  const refund = basis - feeAtCost - HAIRCUT_PER_EXIT
  return refund > 0n ? refund : 0n
}

type EventName = 'SellEvent' | 'AutoExitEvent' | 'AutoExitSetEvent'

/** Anchor `emit!` payloads (`Program data:` logs) of one event type: 8-byte discriminator, then the borsh fields. */
function eventsOf(r: TxResult, name: EventName): Buffer[] {
  if (!r.ok) return []
  const tag = createHash('sha256').update(`event:${name}`).digest().subarray(0, 8)
  return (r.logs ?? [])
    .filter((l) => l.startsWith(PROGRAM_DATA))
    .map((l) => Buffer.from(l.slice(PROGRAM_DATA.length), 'base64'))
    .filter((d) => d.subarray(0, 8).equals(tag))
}

const keyAt = (d: Buffer, offset: number) => new PublicKey(d.subarray(offset, offset + 32))

/** Index of the trader holding the fewest tokens: graduation buys go there so positions stay balanced. */
function leastHeld(tokens: bigint[]): number {
  return tokens.reduce((best, x, i) => (x < tokens[best] ? i : best), 0)
}

const errorDetail = (r: TxResult) => (r.ok ? 'SUCCEEDED (vulnerable!)' : r.error.replace(/\s+/g, ' ').slice(0, 110))

function rejectedWith(r: TxResult, code: number, label: string): void {
  const ok = !r.ok && new RegExp(`code: ${code}\\b`).test(r.error)
  check(ok, `${label} (${code})`, errorDetail(r))
}

async function accountBytes(chain: Chain, address: PublicKey, what: string): Promise<Buffer> {
  const data = await chain.accountData(address)
  if (!data) throw new Error(`${what}: account ${address.toBase58()} not found`)
  return data
}

/** Hex of every watched account: equal before and after means a rejected transaction moved no funds and changed no state. */
const stateOf = (chain: Chain, accounts: PublicKey[]) =>
  Promise.all(accounts.map(async (a) => (await chain.accountData(a))?.toString('hex') ?? 'missing'))

/** Sends, then asserts the exact error code (and its source program, if given) and that no watched account changed. */
async function rejectedUnchanged(
  chain: Chain, watched: PublicKey[], send: () => Promise<TxResult>, code: number, label: string, source?: RegExp,
): Promise<void> {
  const before = await stateOf(chain, watched)
  const r = await send()
  const unchanged = (await stateOf(chain, watched)).every((d, i) => d === before[i])
  const matches = !r.ok && new RegExp(`code: ${code}\\b`).test(r.error) && (!source || source.test(r.error))
  check(matches && unchanged, `${label} (${code}), no balance change`, `${unchanged ? '' : 'STATE CHANGED '}${errorDetail(r)}`)
}

/** True if token account `account` names `delegate` as its delegate. */
async function isDelegatedTo(chain: Chain, account: PublicKey, delegate: PublicKey): Promise<boolean> {
  const d = await accountBytes(chain, account, 'token account')
  return d.readUInt32LE(TOKEN_DELEGATE_OFFSET) === 1 && keyAt(d, TOKEN_DELEGATE_OFFSET + 4).equals(delegate)
}

/** A token account of `owner` at a fresh address (not the canonical ATA). Anyone can create one: here `payer` does. */
async function nonAtaAccount(chain: Chain, payer: Keypair, mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): Promise<PublicKey> {
  const account = Keypair.generate()
  const mintData = await accountBytes(chain, mint, 'mint')
  const space = getAccountLenForMint(unpackMint(mint, { data: mintData, owner: tokenProgram, lamports: 0, executable: false }, tokenProgram))
  must(await chain.send(payer, [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: account.publicKey, lamports: await chain.rentExempt(space), space, programId: tokenProgram,
    }),
    createInitializeAccount3Instruction(account.publicKey, mint, owner, tokenProgram),
  ], [account]), `non-ATA token account for mint ${mint.toBase58()}`)
  return account.publicKey
}

async function clockUnixTimestamp(chain: Chain): Promise<bigint> {
  return (await accountBytes(chain, SYSVAR_CLOCK_PUBKEY, 'clock sysvar')).readBigInt64LE(CLOCK_UNIX_TIMESTAMP_OFFSET)
}

async function warpTo(chain: Chain, unixTimestamp: bigint): Promise<void> {
  if (!chain.setClock) throw new Error(`${chain.name}: cannot warp the clock (LiteSVM only)`)
  chain.setClock(unixTimestamp)
  const now = await clockUnixTimestamp(chain)
  if (now !== unixTimestamp) throw new Error(`clock warp to ${unixTimestamp} left unix_timestamp at ${now}`)
}

function loadScenario(): Scenario {
  const [scenarioPath, indexArg] = process.argv.slice(2)
  if (!scenarioPath) throw new Error('usage: zpvp_auto_exit.ts SCENARIOS.json INDEX')
  const index = Number(indexArg ?? 0)
  const scenario: Scenario | undefined = JSON.parse(readFileSync(scenarioPath, 'utf8'))[index]
  if (!scenario) throw new Error(`no scenario at index ${index} in ${scenarioPath}`)
  return scenario
}

type Ctx = {
  chain: Chain; scenario: Scenario; admin: Keypair
  /** A is the market under test; B shares A's quote mint so its accounts can be smuggled into A's instructions */
  A: MarketFixture; B: MarketFixture
  /** Clock at the start, and the deadline set on positions 0, 1 and EXITER (now + 1 day) */
  now: bigint; future: bigint
}

const own = ({ A }: Ctx, i: number): SetAutoExitAccounts => ({ owner: A.traders[i].publicKey, market: A.market, position: A.positionOf(i) })
const setAutoExit = ({ chain }: Ctx, signer: Keypair, accounts: SetAutoExitAccounts, deadline: bigint) =>
  chain.send(signer, [setAutoExitIx(accounts, deadline)])
const positionBytes = ({ chain }: Ctx, position: PublicKey) => accountBytes(chain, position, 'position')
const deadlineOf = async (ctx: Ctx, position: PublicKey) => (await positionBytes(ctx, position)).readBigInt64LE(POSITION_DEADLINE_OFFSET)
const marketU64 = async ({ chain, A }: Ctx, offset: number) => (await accountBytes(chain, A.market, 'market A')).readBigUInt64LE(offset)

async function setAutoExitSuite(ctx: Ctx): Promise<void> {
  const { chain, A, B, now, future } = ctx
  const t = A.traders

  console.log('-- owner sets and clears')
  const pos0 = A.positionOf(0)
  const fresh = await positionBytes(ctx, pos0)
  check(fresh.length === POSITION_LEN && fresh.readBigInt64LE(POSITION_DEADLINE_OFFSET) === 0n,
    'a position created by buy is 97 bytes with auto-exit disabled (0)', `len=${fresh.length}`)
  must(await setAutoExit(ctx, t[0], own(ctx, 0), future), 'set future deadline')
  const afterSet = await positionBytes(ctx, pos0)
  check(afterSet.readBigInt64LE(POSITION_DEADLINE_OFFSET) === future,
    'owner sets a future deadline (position bytes 89..97 == deadline)', `deadline=${future}`)
  check(afterSet.subarray(0, POSITION_DEADLINE_OFFSET).equals(fresh.subarray(0, POSITION_DEADLINE_OFFSET)),
    'set does not change tokens@72 or basis@80 (bytes 0..89 untouched)',
    `tokens=${afterSet.readBigUInt64LE(POSITION_TOKENS_OFFSET)} basis=${afterSet.readBigUInt64LE(POSITION_BASIS_OFFSET)}`)
  must(await setAutoExit(ctx, t[0], own(ctx, 0), future + ONE_DAY), 'move deadline')
  check((await deadlineOf(ctx, pos0)) === future + ONE_DAY, 'owner moves an existing deadline')
  must(await setAutoExit(ctx, t[0], own(ctx, 0), 0n), 'clear deadline')
  check((await deadlineOf(ctx, pos0)) === 0n, 'owner clears it with 0')

  console.log('-- buys keep the deadline')
  const pos1 = A.positionOf(1)
  must(await setAutoExit(ctx, t[1], own(ctx, 1), future), 'set deadline on position 1')
  const tokensBefore = (await A.readPosition(1)).tokens
  must(await chain.send(t[1], A.buyIxs(1, SEED_BUY)), 'A buy 1 after set')
  check((await deadlineOf(ctx, pos1)) === future && (await A.readPosition(1)).tokens > tokensBefore,
    'a buy after set keeps the deadline', `deadline=${await deadlineOf(ctx, pos1)}`)

  console.log('-- rejections')
  must(await setAutoExit(ctx, t[0], own(ctx, 0), future), 'reset deadline on position 0')
  rejectedWith(await setAutoExit(ctx, t[0], own(ctx, 0), now - 1n), ERR.autoExitDeadlineInPast, 'past deadline rejected')
  rejectedWith(await setAutoExit(ctx, t[0], own(ctx, 0), I64_MIN), ERR.autoExitDeadlineInPast, 'i64::MIN deadline rejected')
  rejectedWith(await setAutoExit(ctx, t[1], { ...own(ctx, 0), owner: t[1].publicKey }, future + 1n), ERR.constraintSeeds,
    "non-owner signer rejected (signs as owner of someone else's position)")
  rejectedWith(await chain.send(t[1], [setAutoExitIx({ ...own(ctx, 0), ownerSigns: false }, future + 1n)]), ERR.accountNotSigner,
    "owner key without the owner's signature rejected")
  rejectedWith(await setAutoExit(ctx, t[0], { ...own(ctx, 0), position: pos1 }, future + 1n), ERR.constraintSeeds,
    "another owner's position rejected")
  rejectedWith(await setAutoExit(ctx, B.traders[0], { owner: B.traders[0].publicKey, market: A.market, position: B.positionOf(0) },
    future + 1n), ERR.constraintSeeds, 'position of market B with market A rejected')
  rejectedWith(await setAutoExit(ctx, t[0], { ...own(ctx, 0), market: B.market }, future + 1n), ERR.constraintSeeds,
    'position of market A with market B rejected')
  rejectedWith(await setAutoExit(ctx, t[5], own(ctx, 5), future), ERR.accountNotInitialized, 'wallet without a position rejected')
  check((await deadlineOf(ctx, pos0)) === future && (await deadlineOf(ctx, pos1)) === future
    && (await deadlineOf(ctx, B.positionOf(0))) === 0n, 'deadlines untouched by all rejected attempts')
}

async function autoExitSuite(ctx: Ctx): Promise<void> {
  const { chain, admin, A, now, future } = ctx
  const t = A.traders
  const crank = t[CRANKER]
  const exitE = exitOf(A, EXITER, crank.publicKey)
  const posE = A.positionOf(EXITER)
  const watched = [...exitWatched(A, EXITER), A.ata[CRANKER].quote, A.ata[CRANKER].base]
  const crankExit = (accounts: AutoExitAccounts) => () => chain.send(crank, [autoExitIx(A, accounts)])

  console.log('-- auto_exit: setup (EXITER buys, approves the market PDA for u64::MAX, sets the deadline; later buys lift the price)')
  must(await chain.send(t[EXITER], A.buyIxs(EXITER, SEED_BUY)), 'A buy EXITER')
  must(await chain.send(t[EXITER], [approveMarketIx(A, EXITER, U64_MAX)]), 'EXITER approves market PDA')
  must(await setAutoExit(ctx, t[EXITER], own(ctx, EXITER), future), 'EXITER sets deadline')
  must(await chain.send(t[IDLE], A.buyIxs(IDLE, SEED_BUY)), 'A buy IDLE')
  must(await chain.send(t[IDLE], [approveMarketIx(A, IDLE, U64_MAX)]), 'IDLE approves market PDA (auto-exit stays disabled)')
  must(await chain.send(t[LATE_BUYER], A.buyIxs(LATE_BUYER, SEED_BUY)), 'A buy LATE_BUYER')

  console.log('-- auto_exit: not due')
  await rejectedUnchanged(chain, watched, crankExit(exitE), ERR.autoExitNotDue, 'auto_exit before the deadline rejected')
  await warpTo(chain, future - 1n)
  await rejectedUnchanged(chain, watched, crankExit(exitE), ERR.autoExitNotDue, 'auto_exit one second before the deadline rejected')
  await warpTo(chain, future)
  check((await clockUnixTimestamp(chain)) === future && future > now, 'clock warped to the deadline (Chain.setClock)', `now=${future}`)
  const idleWatched = exitWatched(A, IDLE)
  const callers: [string, Keypair][] = [['the owner', t[IDLE]], ['a third-party cranker', crank], ['the market admin', admin]]
  for (const [who, caller] of callers) {
    await rejectedUnchanged(chain, idleWatched, () => chain.send(caller, [autoExitIx(A, exitOf(A, IDLE, caller.publicKey))]),
      ERR.autoExitNotDue, `auto_exit with deadline unset (0) rejected for ${who}`)
  }

  console.log('-- auto_exit: account substitution and delegate (deadline passed)')
  await rejectedUnchanged(chain, watched, crankExit({ ...exitE, ownerQuote: A.ata[CRANKER].quote }), ERR.constraintTokenOwner,
    "owner_quote = the cranker's quote ATA rejected")
  must(await chain.send(crank, [approveMarketIx(A, CRANKER, U64_MAX)]), 'cranker approves market PDA on its own base ATA')
  await rejectedUnchanged(chain, watched, crankExit({ ...exitE, ownerBase: A.ata[CRANKER].base }), ERR.constraintTokenOwner,
    "owner_base = the cranker's base ATA (delegated to the market) rejected")
  await rejectedUnchanged(chain, watched, crankExit({ ...exitE, owner: crank.publicKey }), ERR.constraintSeeds,
    'owner account != position.owner rejected (cranker names itself owner)')
  await rejectedUnchanged(chain, watched, crankExit({ ...exitE, owner: t[IDLE].publicKey }), ERR.constraintSeeds,
    "owner account != position.owner rejected (another holder's key)")
  await rejectedUnchanged(chain, watched, crankExit({ ...exitOf(A, CRANKER, crank.publicKey), position: posE }), ERR.constraintSeeds,
    "owner + both ATAs swapped to the cranker's rejected")
  await smuggledAccountsRejected(ctx, watched)
  must(await chain.send(t[EXITER], [revokeIx(A, EXITER)]), 'EXITER revokes the delegate')
  await rejectedUnchanged(chain, watched, crankExit(exitE), TOKEN_ERR.ownerMismatch,
    'auto_exit after the owner revoked the delegate rejected by Token-2022 (OwnerMismatch)', tokenProgramFailed(TOKEN_ERR.ownerMismatch))
  const tokensE = (await A.readPosition(EXITER)).tokens
  must(await chain.send(t[EXITER], [approveMarketIx(A, EXITER, tokensE - 1n)]), 'EXITER approves position.tokens - 1')
  await rejectedUnchanged(chain, watched, crankExit(exitE), TOKEN_ERR.insufficientFunds,
    'auto_exit with the delegate approved for less than position.tokens rejected by Token-2022 (InsufficientFunds)',
    tokenProgramFailed(TOKEN_ERR.insufficientFunds))
  must(await chain.send(t[EXITER], [approveMarketIx(A, EXITER, U64_MAX)]), 'EXITER re-approves u64::MAX')

  console.log('-- auto_exit: a third-party cranker exits the whole position at cost')
  await exitAtCostByCranker(ctx)

  console.log('-- auto_exit: after the exit')
  await rejectedUnchanged(chain, watched, crankExit(exitE), ERR.invalidExitAmount, 'a second auto_exit on the same position rejected')
  await setterBoundaries(ctx)

  console.log('-- auto_exit: a full sell clears the deadline (ONC-19)')
  await fullSellClearsDeadline(ctx)
  console.log('-- auto_exit: a victim delegated to market A, cranked through market B (ONC-19)')
  await crossMarketVictim(ctx)
}

/** ONC-19 review gaps on EXITER's due, delegated position: non-ATA owner accounts, another market's buffer or pool. */
async function smuggledAccountsRejected(ctx: Ctx, watched: PublicKey[]): Promise<void> {
  const { chain, A, B } = ctx
  const crank = A.traders[CRANKER]
  const owner = A.traders[EXITER].publicKey
  const crankExit = (a: Partial<AutoExitAccounts>) => () =>
    chain.send(crank, [autoExitIx(A, { ...exitOf(A, EXITER, crank.publicKey), ...a })])
  const ownerQuote = await nonAtaAccount(chain, crank, A.quoteMintPk, owner, A.quoteTokenProgram)
  const ownerBase = await nonAtaAccount(chain, crank, A.baseMint.publicKey, owner, TOKEN_2022_PROGRAM_ID)
  await rejectedUnchanged(chain, [...watched, ownerQuote], crankExit({ ownerQuote }), ERR.constraintAssociated,
    "non-canonical owner_quote rejected (a non-ATA quote account of the owner's, created by the cranker)")
  await rejectedUnchanged(chain, [...watched, ownerBase], crankExit({ ownerBase }), ERR.constraintAssociated,
    "non-canonical owner_base rejected (a non-ATA base account of the owner's, created by the cranker)")
  const withB = [...watched, B.buffer, B.pool]
  await rejectedUnchanged(chain, withB, crankExit({ buffer: B.buffer }), ERR.constraintHasOne, 'buffer_vault of market B with market A rejected')
  await rejectedUnchanged(chain, withB, crankExit({ pool: B.pool }), ERR.constraintSeeds, 'pool of market B with market A rejected')
}

/** ONC-19: a sell that empties a position clears its deadline, so a re-bought position cannot be auto-exited on the old one. */
async function fullSellClearsDeadline(ctx: Ctx): Promise<void> {
  const { chain, A } = ctx
  const seller = A.traders[FULL_SELLER]
  const crank = A.traders[CRANKER]
  const pos = A.positionOf(FULL_SELLER)
  must(await chain.send(seller, A.buyIxs(FULL_SELLER, SEED_BUY)), 'A buy FULL_SELLER')
  must(await chain.send(seller, [approveMarketIx(A, FULL_SELLER, U64_MAX)]), 'FULL_SELLER approves market PDA')
  const deadline = (await clockUnixTimestamp(chain)) + 1n
  must(await setAutoExit(ctx, seller, own(ctx, FULL_SELLER), deadline), 'FULL_SELLER sets deadline')
  const tokens = (await A.readPosition(FULL_SELLER)).tokens
  must(await chain.send(seller, [A.sellIx(FULL_SELLER, tokens)]), 'manual full sell')
  const after = await positionBytes(ctx, pos)
  check(tokens > 0n && after.length === POSITION_LEN && after.readBigUInt64LE(POSITION_TOKENS_OFFSET) === 0n
    && after.readBigUInt64LE(POSITION_BASIS_OFFSET) === 0n && after.readBigInt64LE(POSITION_DEADLINE_OFFSET) === 0n,
    'after set_auto_exit a manual full sell clears the deadline (tokens, basis and deadline 0)',
    `sold=${tokens} deadline=${after.readBigInt64LE(POSITION_DEADLINE_OFFSET)}`)

  must(await chain.send(seller, A.buyIxs(FULL_SELLER, SEED_BUY)), 'FULL_SELLER buys again')
  await warpTo(chain, deadline)
  check((await isDelegatedTo(chain, A.ata[FULL_SELLER].base, A.market)) && (await A.readPosition(FULL_SELLER)).tokens > 0n
    && (await deadlineOf(ctx, pos)) === 0n,
    're-bought position: old deadline passed, market PDA still its delegate, auto-exit stays disabled (0)')
  await rejectedUnchanged(chain, [...exitWatched(A, FULL_SELLER), A.ata[CRANKER].quote, A.ata[CRANKER].base],
    () => chain.send(crank, [autoExitIx(A, exitOf(A, FULL_SELLER, crank.publicKey))]), ERR.autoExitNotDue,
    'a re-bought position cannot be auto-exited on the deadline set before the full sell')
}

/**
 * ONC-19: a victim whose base ATA delegates to market A (deadline passed) and who also holds a due position in market B
 * cannot be auto-exited through market B's accounts. Control: the same exit through A's own accounts succeeds.
 */
async function crossMarketVictim(ctx: Ctx): Promise<void> {
  const { chain, A, B } = ctx
  const victim = A.traders[VICTIM]
  const crank = A.traders[CRANKER]
  const posB = positionPda(B.market, victim.publicKey)
  const baseB = getAssociatedTokenAddressSync(B.baseMint.publicKey, victim.publicKey, false, TOKEN_2022_PROGRAM_ID)
  must(await chain.send(victim, A.buyIxs(VICTIM, SEED_BUY)), 'A buy VICTIM')
  must(await chain.send(victim, [approveMarketIx(A, VICTIM, U64_MAX)]), 'VICTIM approves market A PDA')
  must(await chain.send(victim, [
    createAssociatedTokenAccountIdempotentInstruction(victim.publicKey, baseB, victim.publicKey, B.baseMint.publicKey, TOKEN_2022_PROGRAM_ID),
    foreignBuyIx(B, victim.publicKey, { position: posB, userQuote: A.ata[VICTIM].quote, userBase: baseB }, SEED_BUY),
  ]), 'B buy VICTIM (shared quote mint, so the same quote ATA)')
  const deadline = (await clockUnixTimestamp(chain)) + 1n
  must(await setAutoExit(ctx, victim, own(ctx, VICTIM), deadline), 'VICTIM sets an A deadline')
  must(await setAutoExit(ctx, victim, { owner: victim.publicKey, market: B.market, position: posB }, deadline), 'VICTIM sets a B deadline')
  await warpTo(chain, deadline)

  const victimA = exitOf(A, VICTIM, crank.publicKey)
  const viaB = (a: Partial<AutoExitAccounts>) => () => chain.send(crank, [autoExitIx(B, { ...victimA, ...a })])
  const watched = [...exitWatched(A, VICTIM), posB, baseB, B.market, B.buffer, B.pool, B.baseVault, B.quoteVault]
  await rejectedUnchanged(chain, watched, viaB({}), ERR.constraintSeeds,
    "victim delegated to market A: its A position through market B's accounts rejected")
  await rejectedUnchanged(chain, watched, viaB({ position: posB }), ERR.constraintAssociated,
    'victim delegated to market A: its due B position with the market-A-delegated base ATA through market B rejected')
  const r = await chain.send(crank, [autoExitIx(A, victimA)])
  check(r.ok && (await A.readPosition(VICTIM)).tokens === 0n,
    "control: the same victim is auto-exited through market A's own accounts", r.ok ? '' : r.error.slice(0, 110))
}

/** The positive path: every field auto_exit touches, checked against values read before the exit. */
async function exitAtCostByCranker(ctx: Ctx): Promise<void> {
  const { chain, A } = ctx
  const t = A.traders
  const crank = t[CRANKER]
  const before = await positionBytes(ctx, A.positionOf(EXITER))
  const tokens = before.readBigUInt64LE(POSITION_TOKENS_OFFSET)
  const basis = before.readBigUInt64LE(POSITION_BASIS_OFFSET)
  const fee = await marketU64(ctx, MARKET_FEE_OFFSET)
  const totalBasis = await marketU64(ctx, MARKET_TOTAL_BASIS_OFFSET)
  const [ownerQuote, ownerBase, buffer, crankQuote, crankBase] =
    await Promise.all([A.ata[EXITER].quote, A.ata[EXITER].base, A.buffer, A.ata[CRANKER].quote, A.ata[CRANKER].base].map(A.balanceOf))
  const [crankLamports, ownerLamports] = await Promise.all([chain.lamports(crank.publicKey), chain.lamports(t[EXITER].publicKey)])

  const r = await chain.send(crank, [autoExitIx(A, exitOf(A, EXITER, crank.publicKey))])
  must(r, 'auto_exit by a third-party cranker')
  const refund = refundFor(basis, fee)
  const after = await positionBytes(ctx, A.positionOf(EXITER))
  const ownerBaseAfter = await A.balanceOf(A.ata[EXITER].base)
  check(r.ok && tokens > 0n && ownerBaseAfter === ownerBase - tokens,
    'after the deadline a third-party cranker exits the whole position (owner_base -= position.tokens)',
    `tokens=${tokens} cu=${r.ok ? r.cu : '-'}`)
  const gained = (await A.balanceOf(A.ata[EXITER].quote)) - ownerQuote
  check(refund > 0n && gained === refund, "owner_quote gains exactly refund_for(basis, fee)", `basis=${basis} fee=${fee} refund=${refund}`)
  check(after.length === POSITION_LEN && after.readBigUInt64LE(POSITION_TOKENS_OFFSET) === 0n
    && after.readBigUInt64LE(POSITION_BASIS_OFFSET) === 0n && after.readBigInt64LE(POSITION_DEADLINE_OFFSET) === 0n,
    'position tokens, basis and deadline become 0 (97-byte account kept)')
  const totalBasisAfter = await marketU64(ctx, MARKET_TOTAL_BASIS_OFFSET)
  check(totalBasisAfter === totalBasis - basis, 'market.total_basis drops by exactly that basis', `${totalBasis} -> ${totalBasisAfter}`)

  const sells = eventsOf(r, 'SellEvent')
  const exits = eventsOf(r, 'AutoExitEvent')
  const sell = sells[0]
  const proceeds = sell?.readBigUInt64LE(SELL_PROCEEDS) ?? -1n
  const bufferAfter = await A.balanceOf(A.buffer)
  check(sells.length === 1 && proceeds >= 0n && bufferAfter === buffer + proceeds - refund && buffer + proceeds >= refund,
    'the buffer is never negative (buffer_after = buffer_before + proceeds - refund >= 0)',
    `buffer ${buffer} + proceeds ${proceeds} - refund ${refund} = ${bufferAfter}`)
  check(sells.length === 1 && keyAt(sell, EVENT_MARKET).equals(A.market) && keyAt(sell, EVENT_USER).equals(t[EXITER].publicKey)
    && sell.readBigUInt64LE(SELL_TOKENS) === tokens && sell.readBigUInt64LE(SELL_BASIS_PART) === basis
    && sell.readBigUInt64LE(SELL_REFUND) === refund,
    'SellEvent emitted (market, user = owner, tokens, basis_part = basis, proceeds, refund)')
  const exit = exits[0]
  check(exits.length === 1 && keyAt(exit, EVENT_MARKET).equals(A.market) && keyAt(exit, EVENT_USER).equals(t[EXITER].publicKey)
    && keyAt(exit, AUTO_EXIT_CRANKER).equals(crank.publicKey),
    'AutoExitEvent emitted and decoded from TxResult.logs (market, user, cranker)')

  const [crankQuoteAfter, crankBaseAfter] = await Promise.all([A.ata[CRANKER].quote, A.ata[CRANKER].base].map(A.balanceOf))
  const [crankLamportsAfter, ownerLamportsAfter] = await Promise.all([chain.lamports(crank.publicKey), chain.lamports(t[EXITER].publicKey)])
  check(crankQuoteAfter === crankQuote && crankBaseAfter === crankBase && crankLamports - crankLamportsAfter === TX_FEE
    && ownerLamportsAfter === ownerLamports, 'the cranker pays only the transaction fee and gains nothing; owner SOL untouched',
    `cranker lamports -${crankLamports - crankLamportsAfter}`)
}

/** set_auto_exit edges on the warped clock, AutoExitSetEvent, and a manual sell on a position whose deadline is set. */
async function setterBoundaries(ctx: Ctx): Promise<void> {
  const { chain, A, future } = ctx
  const t = A.traders
  const now = await clockUnixTimestamp(chain)
  rejectedWith(await setAutoExit(ctx, t[IDLE], own(ctx, IDLE), now), ERR.autoExitDeadlineInPast, 'set_auto_exit(deadline == now) rejected')
  const r = await setAutoExit(ctx, t[IDLE], own(ctx, IDLE), I64_MAX)
  check(r.ok && (await deadlineOf(ctx, A.positionOf(IDLE))) === I64_MAX, 'set_auto_exit(i64::MAX) accepted')
  const set = eventsOf(r, 'AutoExitSetEvent')
  check(set.length === 1 && keyAt(set[0], EVENT_MARKET).equals(A.market) && keyAt(set[0], EVENT_USER).equals(t[IDLE].publicKey)
    && set[0].readBigInt64LE(AUTO_EXIT_SET_DEADLINE) === I64_MAX, 'AutoExitSetEvent decoded from TxResult.logs (market, user, deadline)')
  await rejectedUnchanged(chain, exitWatched(A, IDLE), () => chain.send(t[CRANKER], [autoExitIx(A, exitOf(A, IDLE, t[CRANKER].publicKey))]),
    ERR.autoExitNotDue, 'auto_exit with deadline i64::MAX rejected')
  must(await setAutoExit(ctx, t[IDLE], own(ctx, IDLE), 0n), 'IDLE clears its deadline')

  const pos1 = A.positionOf(1)
  const before = await positionBytes(ctx, pos1)
  const tokens = before.readBigUInt64LE(POSITION_TOKENS_OFFSET) / 2n
  const quoteBefore = await A.balanceOf(A.ata[1].quote)
  must(await chain.send(t[1], [A.sellIx(1, tokens)]), 'manual sell on position 1')
  const after = await positionBytes(ctx, pos1)
  check(after.length === POSITION_LEN && after.readBigInt64LE(POSITION_DEADLINE_OFFSET) === future
    && after.readBigUInt64LE(POSITION_TOKENS_OFFSET) === before.readBigUInt64LE(POSITION_TOKENS_OFFSET) - tokens
    && (await A.balanceOf(A.ata[1].quote)) > quoteBefore,
    'after set_auto_exit a manual sell still works on the 97-byte position (deadline kept)', `sold=${tokens}`)
}

async function graduationSuite(ctx: Ctx): Promise<void> {
  const { chain, admin, scenario, A, future } = ctx
  const t = A.traders
  const pos0 = A.positionOf(0)
  const pos1 = A.positionOf(1)

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
  check((await deadlineOf(ctx, pos0)) === future && (await deadlineOf(ctx, pos1)) === future, 'graduation buys keep the deadlines')
  must(await chain.send(t[0], [approveMarketIx(A, 0, U64_MAX)]), 'trader 0 approves market PDA')
  const watched0 = exitWatched(A, 0)
  const crankExit0 = () => chain.send(t[CRANKER], [autoExitIx(A, exitOf(A, 0, t[CRANKER].publicKey))])
  check((await clockUnixTimestamp(chain)) >= future, 'position 0 deadline has passed', `deadline=${future}`)
  await rejectedUnchanged(chain, watched0, crankExit0, ERR.autoExitCurveComplete, 'auto_exit after graduation rejected')
  must(await chain.send(admin, [A.finalizeIx()]), 'finalize A')
  await rejectedUnchanged(chain, watched0, crankExit0, ERR.autoExitCurveComplete, 'auto_exit after finalize rejected')
  rejectedWith(await setAutoExit(ctx, t[0], own(ctx, 0), future + 1n), ERR.alreadyFinalized, 'set on a finalized market rejected')
  rejectedWith(await setAutoExit(ctx, t[0], own(ctx, 0), 0n), ERR.alreadyFinalized, 'clear on a finalized market rejected')
  check((await deadlineOf(ctx, pos0)) === future, 'deadline untouched after finalize')

  const basis = (await A.readPosition(0)).basis
  const expected = ((await marketU64(ctx, MARKET_SURPLUS_SNAPSHOT_OFFSET)) * basis) / (await marketU64(ctx, MARKET_BASIS_SNAPSHOT_OFFSET))
  const quoteBefore = await A.balanceOf(A.ata[0].quote)
  must(await chain.send(t[CRANKER], [A.claimIx(t[CRANKER].publicKey, 0)]), 'crank claim for position 0')
  const share = (await A.balanceOf(A.ata[0].quote)) - quoteBefore
  check(share === expected && expected > 0n && (await chain.accountData(pos0)) === null,
    'claim_surplus still works on the 97-byte position with a deadline set (exact share, position closed)', `share=${share}`)
}

async function main() {
  const scenario = loadScenario()
  const chain = liteSvmChain(zpvpPrograms())
  const admin = Keypair.generate()
  await chain.fund(admin.publicKey, 10n ** 16n)

  const A = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: TRADERS, traderLamports: TRADER_LAMPORTS })
  const B = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: 1, traderLamports: TRADER_LAMPORTS, quoteMint: A.quoteMintPk })
  must(await chain.send(A.traders[0], A.buyIxs(0, SEED_BUY)), 'A buy 0')
  must(await chain.send(A.traders[1], A.buyIxs(1, SEED_BUY)), 'A buy 1')
  must(await chain.send(B.traders[0], B.buyIxs(0, SEED_BUY)), 'B buy 0')
  const now = await clockUnixTimestamp(chain)
  const ctx: Ctx = { chain, scenario, admin, A, B, now, future: now + ONE_DAY }

  await setAutoExitSuite(ctx)
  await autoExitSuite(ctx)
  await graduationSuite(ctx)
}

main().catch((e) => { console.error(e); process.exit(1) })
