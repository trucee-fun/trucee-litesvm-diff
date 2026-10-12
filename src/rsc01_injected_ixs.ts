/**
 * Do wallet-injected top-level instructions break the Zero-PvP hook?
 *
 * The hook allows a base-token transfer only when get_instruction_relative(0) (the top-level instruction that is
 * executing) belongs to the router. Wallets add their own top-level instructions (compute budget, memos, Phantom's
 * Lighthouse guards). This script shows that router buys and sells still pass with such instructions before and
 * after them, and that a transfer whose own top-level instruction is not the router still fails with
 * TransferNotViaRouter (6000).
 *
 * LiteSVM (wSOL quote, so the capped router build works). LIGHTHOUSE_SO (optional) is a dump of the real Lighthouse
 * program (`solana program dump -u https://api.devnet.solana.com L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95 FILE`);
 * without it the Lighthouse cases print SKIP and only the memo stand-in runs.
 *   ROUTER_SO=... HOOK_SO=... [LIGHTHOUSE_SO=...] npx tsx src/rsc01_injected_ixs.ts SCENARIOS.json INDEX
 *
 * Devnet, read-only: simulateTransaction (sigVerify false, replaceRecentBlockhash true) of the app's buy, wrapped in
 * memo + compute-budget instructions, through the public devnet RPC. Sends nothing. USER_REF names a transaction in
 * the e2e file whose fee payer acts as the funded user: a key of the file's `signatures`, or `op:N` for its N-th op.
 * Only pubkeys and signatures are read from the file.
 *   npx tsx src/rsc01_injected_ixs.ts --devnet out/e2e_devnet_v4.json USER_REF       # the file's market, 4 RPC calls
 *   npx tsx src/rsc01_injected_ixs.ts --devnet-live out/e2e_devnet_v4.json USER_REF  # first live wSOL market, 5 calls
 */
import { readFileSync } from 'node:fs'
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js'
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, getAssociatedTokenAddressSync, getTransferHook, unpackMint,
} from '@solana/spl-token'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID, deriveDbcTokenVaultAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Chain, TxResult, liteSvmChain } from './chain'
import {
  HOOK_ID, MARKET_TOTAL_BASIS_OFFSET, MarketFixture, POOL_MIGRATION_PROGRESS_OFFSET, ROUTER_ID, Scenario, ZPVP_DEPLOY,
  anchorError, check, createMarketFixture, disc, eventAuthority, meta, must, pda, poolAuthority, u64,
} from './fixture'

/** The public devnet RPC used for read-only transaction simulation. Never read an RPC URL from out/*.json (it may carry a key). */
const DEVNET_RPC = 'https://api.devnet.solana.com'
const MEMO_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
/** Lighthouse, the assertion program Phantom appends as "guard instructions" (same ID on devnet and mainnet). */
export const LIGHTHOUSE_ID = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95')
// Lighthouse instruction data, borsh (source pinned at Jac0xb/lighthouse@4c57947): LighthouseInstruction index 9 =
// AssertTokenAccount { log_level: u8, assertion }, TokenAccountAssertion index 2 = Amount { value: u64, operator: u8 }.
const LH_ASSERT_TOKEN_ACCOUNT = 9
const LH_LOG_PLAINTEXT = 1
const LH_TOKEN_AMOUNT = 2
const OP_EQUAL = 0
const OP_GREATER_THAN = 2
const LH_ASSERTION_FAILED = 6001
const HOOK_NOT_VIA_ROUTER = 6000
const hookRejected = (index: number) => anchorError(HOOK_NOT_VIA_ROUTER, 'TransferNotViaRouter', index)
/** Through DBC the hook's AnchorError line falls outside chain.ts's 3-line log tail; the hook's own failure line stays (0x1770 = 6000). */
const hookRejectedUnderDbc = (index: number) => new RegExp(
  `index: ${index}, error: InstructionErrorCustom \\{ code: ${HOOK_NOT_VIA_ROUTER} \\}[\\s\\S]*Program ${HOOK_ID.toBase58()} failed: custom program error: 0x1770`)
const lighthouseFailed = (index: number) =>
  new RegExp(`index: ${index}, error: InstructionErrorCustom \\{ code: ${LH_ASSERTION_FAILED} \\}[\\s\\S]*${LIGHTHOUSE_ID.toBase58()} failed`)

const LEGACY_TX_LIMIT = 1232
/** Phantom appended four Lighthouse guards to a Jupiter buy (rebeltrenches/signal-platform#60). */
const PHANTOM_GUARD_COUNT = 4
const CU_LIMIT = 400_000
const CU_PRICE_MICROLAMPORTS = 10_000
const TRADERS = 3
const TRADER_LAMPORTS = 10n ** 15n
const FRESH_USER_LAMPORTS = 10n ** 10n
/** Buy size = threshold / BUY_DIVISOR: a dozen buys stay far below the Anti-Whale cap and the graduation threshold. */
const BUY_DIVISOR = 200n
const DEVNET_BUY_AMOUNT = 1_000_000n
const MARKET_FINALIZED_OFFSET = MARKET_TOTAL_BASIS_OFFSET + 8
const LOG_TAIL = 14

export type MarketAccounts = {
  market: PublicKey; buffer: PublicKey; config: PublicKey; pool: PublicKey; baseMint: PublicKey; quoteMint: PublicKey
  quoteTokenProgram: PublicKey
}

export const memoIx = (text: string) => new TransactionInstruction({ programId: MEMO_ID, keys: [], data: Buffer.from(text, 'utf8') })
export const computeBudgetIxs = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICROLAMPORTS }),
]
/** Lighthouse AssertTokenAccount: `tokenAccount`.amount <operator> `value`, else the transaction fails with 6001. */
export const lighthouseAmountIx = (tokenAccount: PublicKey, value: bigint, operator: number) => new TransactionInstruction({
  programId: LIGHTHOUSE_ID, keys: [meta(tokenAccount)],
  data: Buffer.concat([Buffer.from([LH_ASSERT_TOKEN_ACCOUNT, LH_LOG_PLAINTEXT, LH_TOKEN_AMOUNT]), u64(value), Buffer.from([operator])]),
})

const atasOf = (m: MarketAccounts, user: PublicKey) => ({
  quote: getAssociatedTokenAddressSync(m.quoteMint, user, false, m.quoteTokenProgram),
  base: getAssociatedTokenAddressSync(m.baseMint, user, false, TOKEN_2022_PROGRAM_ID),
})

/** Router `buy` for any user. Account order = fixture.ts routerIx = sdk routerSwapInstruction (Swap struct unchanged since dd7cc10). */
export function routerBuyIx(m: MarketAccounts, user: PublicKey, amountIn: bigint, minOut = 0n): TransactionInstruction {
  const ata = atasOf(m, user)
  return new TransactionInstruction({ programId: ROUTER_ID, data: Buffer.concat([disc('buy'), u64(amountIn), u64(minOut)]), keys: [
    meta(user, true, true), meta(m.market, true), meta(pda([Buffer.from('position'), m.market.toBuffer(), user.toBuffer()], ROUTER_ID), true),
    meta(ata.quote, true), meta(ata.base, true), meta(m.buffer, true), meta(poolAuthority), meta(m.config), meta(m.pool, true),
    meta(deriveDbcTokenVaultAddress(m.pool, m.baseMint), true), meta(deriveDbcTokenVaultAddress(m.pool, m.quoteMint), true),
    meta(m.baseMint, true), meta(m.quoteMint), meta(TOKEN_2022_PROGRAM_ID), meta(m.quoteTokenProgram), meta(eventAuthority),
    meta(DYNAMIC_BONDING_CURVE_PROGRAM_ID), meta(SystemProgram.programId),
    meta(pda([Buffer.from('extra-account-metas'), m.baseMint.toBuffer()], HOOK_ID)), meta(SYSVAR_INSTRUCTIONS_PUBKEY), meta(HOOK_ID),
  ] })
}

/** The app's first buy (sdk buyInstructions: both ATAs, wSOL wrap, router buy) behind a compute budget. */
export function appBuyIxs(m: MarketAccounts, user: PublicKey, amountIn: bigint): TransactionInstruction[] {
  const ata = atasOf(m, user)
  const wrap = m.quoteMint.equals(NATIVE_MINT)
    ? [SystemProgram.transfer({ fromPubkey: user, toPubkey: ata.quote, lamports: amountIn }), createSyncNativeInstruction(ata.quote, m.quoteTokenProgram)]
    : []
  return [
    ...computeBudgetIxs(),
    createAssociatedTokenAccountIdempotentInstruction(user, ata.quote, user, m.quoteMint, m.quoteTokenProgram),
    createAssociatedTokenAccountIdempotentInstruction(user, ata.base, user, m.baseMint, TOKEN_2022_PROGRAM_ID),
    ...wrap, routerBuyIx(m, user, amountIn),
  ]
}

const DUMMY_BLOCKHASH = PublicKey.default.toBase58()
const toTx = (payer: PublicKey, ixs: TransactionInstruction[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: DUMMY_BLOCKHASH, instructions: ixs }).compileToLegacyMessage())
/** Serialized legacy transaction size, signatures included (Solana's packet limit is 1232 bytes). */
export const txBytes = (payer: PublicKey, ixs: TransactionInstruction[]) => toTx(payer, ixs).serialize().length

const hookRuns = (logs: string[] = []) => logs.filter((l) => l.startsWith(`Program ${HOOK_ID.toBase58()} invoke`)).length
const routerIndex = (ixs: TransactionInstruction[]) => ixs.findIndex((ix) => ix.programId.equals(ROUTER_ID))
const ERROR_DETAIL_CHARS = 300
const brief = (r: TxResult) => (r.ok ? 'SUCCEEDED' : r.error.replace(/\s+/g, ' ').slice(0, ERROR_DETAIL_CHARS))

// ---------------------------------------------------------------- LiteSVM

type Ctx = { chain: Chain; m: MarketFixture; amount: bigint; lighthouse: boolean }

const stateOf = (chain: Chain, accounts: PublicKey[]) =>
  Promise.all(accounts.map(async (a) => (await chain.accountData(a))?.toString('hex') ?? 'missing'))
const watched = ({ m }: Ctx) => [
  m.market, m.buffer, m.pool, m.baseVault, m.quoteVault, ...m.traders.flatMap((_, i) => [m.positionOf(i), m.ata[i].quote, m.ata[i].base]),
]

/** Sends `ixs` signed by trader `i`; passes when it succeeds, the hook ran and the router position changed. */
async function passes(ctx: Ctx, label: string, i: number, ixs: TransactionInstruction[]): Promise<void> {
  const before = await ctx.m.readPosition(i)
  const r = await ctx.chain.send(ctx.m.traders[i], ixs)
  const after = await ctx.m.readPosition(i)
  const runs = r.ok ? hookRuns(r.logs) : 0
  const layout = ixs.map((ix) => (ix.programId.equals(ROUTER_ID) ? 'ROUTER' : programName(ix.programId))).join(',')
  check(r.ok && runs > 0 && after.tokens !== before.tokens, label,
    r.ok ? `[${layout}] router at ix ${routerIndex(ixs)}/${ixs.length}, hook ran ${runs}x, position ${before.tokens} -> ${after.tokens}` : brief(r))
}

/** Sends `ixs`; passes when it fails with exactly `expected` and no watched account changed. */
async function rejected(ctx: Ctx, label: string, signer: Keypair, ixs: TransactionInstruction[], expected: RegExp): Promise<void> {
  const accounts = watched(ctx)
  const before = await stateOf(ctx.chain, accounts)
  const r = await ctx.chain.send(signer, ixs)
  const unchanged = (await stateOf(ctx.chain, accounts)).every((d, k) => d === before[k])
  check(!r.ok && expected.test(r.error) && unchanged, label, `${unchanged ? '' : 'STATE CHANGED '}${brief(r)}`)
}

function programName(id: PublicKey): string {
  const names: [PublicKey, string][] = [[MEMO_ID, 'memo'], [LIGHTHOUSE_ID, 'lighthouse'], [ComputeBudgetProgram.programId, 'cb'],
    [SystemProgram.programId, 'system'], [TOKEN_PROGRAM_ID, 'token'], [TOKEN_2022_PROGRAM_ID, 'token22'],
    [DYNAMIC_BONDING_CURVE_PROGRAM_ID, 'DBC']]
  return names.find(([p]) => p.equals(id))?.[1] ?? id.toBase58().slice(0, 6)
}

async function memoAndComputeBudget(ctx: Ctx): Promise<void> {
  const { m, amount } = ctx
  console.log('-- router buy/sell with injected top-level instructions (memo = stand-in for wallet instructions)')
  await passes(ctx, 'buy, memo before', 0, [memoIx('wallet-before'), ...m.buyIxs(0, amount)])
  await passes(ctx, 'buy, memo after', 1, [...m.buyIxs(1, amount), memoIx('wallet-after')])
  await passes(ctx, 'buy, memo before and after', 2, [memoIx('wallet-before'), ...m.buyIxs(2, amount), memoIx('wallet-after')])
  await passes(ctx, 'buy, compute budget first', 0, [...computeBudgetIxs(), ...m.buyIxs(0, amount)])
  await passes(ctx, 'buy, compute budget + memo before, memo after', 1,
    [...computeBudgetIxs(), memoIx('wallet-before'), ...m.buyIxs(1, amount), memoIx('wallet-after')])
  const half = (await m.readPosition(2)).tokens / 2n
  await passes(ctx, 'sell (exit at cost), compute budget + memo before, memo after', 2,
    [...computeBudgetIxs(), memoIx('wallet-before'), m.sellIx(2, half), memoIx('wallet-after')])
}

async function lighthouseGuards(ctx: Ctx): Promise<void> {
  const { m, amount } = ctx
  console.log('-- real Lighthouse program (Phantom guard instructions)')
  if (!ctx.lighthouse) {
    console.log('SKIP  Lighthouse cases (set LIGHTHOUSE_SO to a dump of L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95)')
    return
  }
  const baseOf = (i: number) => m.balanceOf(m.ata[i].base)
  const base0 = await baseOf(0)
  const quote0 = await m.balanceOf(m.ata[0].quote)
  await passes(ctx, 'buy, Lighthouse guards before and after (base before == x, base after > x, wSOL after == before)', 0, [
    ...computeBudgetIxs(), lighthouseAmountIx(m.ata[0].base, base0, OP_EQUAL), ...m.buyIxs(0, amount),
    lighthouseAmountIx(m.ata[0].base, base0, OP_GREATER_THAN), lighthouseAmountIx(m.ata[0].quote, quote0, OP_EQUAL),
  ])
  const base1 = await baseOf(1)
  const sold = base1 / 3n
  await passes(ctx, 'sell, Lighthouse guard on the exact post-sell base balance', 1,
    [...computeBudgetIxs(), m.sellIx(1, sold), lighthouseAmountIx(m.ata[1].base, base1 - sold, OP_EQUAL)])

  const now0 = await baseOf(0)
  const buy = m.buyIxs(0, amount)
  await rejected(ctx, `failing Lighthouse guard after a buy reverts the buy (${LH_ASSERTION_FAILED} AssertionFailed)`, m.traders[0],
    [...buy, lighthouseAmountIx(m.ata[0].base, now0, OP_EQUAL)], lighthouseFailed(buy.length))
  await rejected(ctx, `Lighthouse guard does not unlock a direct transfer (${HOOK_NOT_VIA_ROUTER} TransferNotViaRouter)`, m.traders[0],
    [lighthouseAmountIx(m.ata[0].base, now0, OP_EQUAL), m.transferIx(0, 1, 1n, true)], hookRejected(1))
}

async function hookStillBlocks(ctx: Ctx): Promise<void> {
  const { m, amount } = ctx
  console.log(`-- negatives: transfers whose top-level instruction is not the router (${HOOK_NOT_VIA_ROUTER} TransferNotViaRouter)`)
  const around = [...computeBudgetIxs(), memoIx('wallet-before'), ...m.buyIxs(0, amount)]
  await rejected(ctx, 'direct Token-2022 transfer after a router buy, CB + memo around', m.traders[0],
    [...around, m.transferIx(0, 1, 1n, true), memoIx('wallet-after')], hookRejected(around.length))
  await rejected(ctx, 'direct Token-2022 transfer before a router buy', m.traders[0],
    [m.transferIx(0, 1, 1n, true), ...m.buyIxs(0, amount)], hookRejected(0))
  const dbcBuy = await m.directDbcBuyIxs(0, amount)
  await rejected(ctx, 'direct DBC swap (DBC CPIs the transfer; top-level is DBC), memo before and after', m.traders[0],
    [memoIx('wallet-before'), ...dbcBuy, memoIx('wallet-after')], hookRejectedUnderDbc(dbcBuy.length))
}

/** A fresh user's first buy built like the app (validates routerBuyIx before it is used on devnet) and its size. */
async function appFirstBuy(ctx: Ctx): Promise<void> {
  const { chain, m, amount } = ctx
  console.log('-- app-shaped first buy for a fresh user (routerBuyIx, used for the devnet simulation)')
  const user = Keypair.generate()
  await chain.fund(user.publicKey, FRESH_USER_LAMPORTS)
  const accounts: MarketAccounts = { market: m.market, buffer: m.buffer, config: m.config.publicKey, pool: m.pool,
    baseMint: m.baseMint.publicKey, quoteMint: m.quoteMintPk, quoteTokenProgram: m.quoteTokenProgram }
  const ixs = [memoIx('wallet-before'), ...appBuyIxs(accounts, user.publicKey, amount), memoIx('wallet-after')]
  const r = await chain.send(user, ixs)
  const tokens = await m.balanceOf(atasOf(accounts, user.publicKey).base)
  check(r.ok && hookRuns(r.logs) > 0 && tokens > 0n, 'fresh user: memo + CB + ATAs + wrap + router buy + memo',
    r.ok ? `hook ran ${hookRuns(r.logs)}x, ${tokens} base tokens, ${r.cu} CU` : brief(r))
  reportSizes(accounts, user.publicKey, amount)
}

function reportSizes(accounts: MarketAccounts, user: PublicKey, amount: bigint): void {
  const app = appBuyIxs(accounts, user, amount)
  const ata = atasOf(accounts, user)
  const guards = Array.from({ length: PHANTOM_GUARD_COUNT }, (_, k) => lighthouseAmountIx(k % 2 ? ata.quote : ata.base, 0n, OP_EQUAL))
  const sizes: [string, TransactionInstruction[]][] = [
    ['app first buy (CB, 2 ATAs, wrap, buy)', app],
    [`app first buy + ${PHANTOM_GUARD_COUNT} Lighthouse guards`, [...app, ...guards]],
    ['router buy only', [routerBuyIx(accounts, user, amount)]],
  ]
  for (const [label, ixs] of sizes) {
    const bytes = txBytes(user, ixs)
    console.log(`SIZE  ${label}: ${bytes} bytes, ${LEGACY_TX_LIMIT - bytes} bytes left of ${LEGACY_TX_LIMIT}`)
  }
}

function liteSvmPrograms(): [PublicKey, string][] {
  const lighthouse = process.env.LIGHTHOUSE_SO
  return [
    [DYNAMIC_BONDING_CURVE_PROGRAM_ID, process.env.DBC_SO ?? 'programs/dbc.so'],
    [HOOK_ID, process.env.HOOK_SO ?? `${ZPVP_DEPLOY}/zpvp_hook.so`],
    [ROUTER_ID, process.env.ROUTER_SO ?? `${ZPVP_DEPLOY}/zpvp_router.so`],
    ...(lighthouse ? [[LIGHTHOUSE_ID, lighthouse] as [PublicKey, string]] : []),
  ]
}

async function runLiteSvm(scenarioPath: string, index: number): Promise<void> {
  const scenario: Scenario | undefined = JSON.parse(readFileSync(scenarioPath, 'utf8'))[index]
  if (!scenario) throw new Error(`no scenario at index ${index} in ${scenarioPath}`)
  const chain = liteSvmChain(liteSvmPrograms())
  const admin = Keypair.generate()
  await chain.fund(admin.publicKey, 10n ** 16n)
  const m = await createMarketFixture(chain, admin, scenario, { wsol: true, traderCount: TRADERS, traderLamports: TRADER_LAMPORTS })
  const ctx: Ctx = { chain, m, amount: BigInt(scenario.migration_quote_threshold) / BUY_DIVISOR, lighthouse: !!process.env.LIGHTHOUSE_SO }
  must(await chain.send(m.traders[2], m.buyIxs(2, ctx.amount)), 'seed buy')
  await memoAndComputeBudget(ctx)
  await lighthouseGuards(ctx)
  await hookStillBlocks(ctx)
  await appFirstBuy(ctx)
  check(!(await m.curveDone()), 'curve still live (every case above ran before graduation)')
}

// ---------------------------------------------------------------- devnet (read-only)

type E2eOut = { accounts: Record<string, string>; signatures?: Record<string, string>; ops?: { signature?: string }[] }

/** Market = disc 8 | pool, config, base_mint, quote_mint, base_vault, quote_vault, buffer_vault | fee u64 | bump | total_basis | finalized | 3 x u64. */
const MARKET_LEN = 274
const MARKET_KEYS_OFFSET = 8
const MAX_MULTIPLE_ACCOUNTS = 100

function marketFromFile(path: string): { out: E2eOut; m: MarketAccounts } {
  const out = JSON.parse(readFileSync(path, 'utf8')) as E2eOut
  const key = (name: string) => {
    const v = out.accounts?.[name]
    if (typeof v !== 'string') throw new Error(`${path}: accounts.${name} missing`)
    return new PublicKey(v)
  }
  // devnet e2e runs used wSOL or a fresh SPL mint as the quote, both owned by SPL Token
  return { out, m: { market: key('market'), buffer: key('buffer'), config: key('config'), pool: key('pool'), baseMint: key('base_mint'),
    quoteMint: key('quote_mint'), quoteTokenProgram: TOKEN_PROGRAM_ID } }
}

function marketFromAccount(market: PublicKey, data: Buffer): MarketAccounts & { finalized: boolean } {
  const key = (k: number) => new PublicKey(data.subarray(MARKET_KEYS_OFFSET + 32 * k, MARKET_KEYS_OFFSET + 32 * (k + 1)))
  return { market, pool: key(0), config: key(1), baseMint: key(2), quoteMint: key(3), buffer: key(6),
    quoteTokenProgram: TOKEN_PROGRAM_ID, finalized: data[MARKET_FINALIZED_OFFSET] === 1 }
}

/** Fee payer of a transaction named in the e2e file (`signatures` key, or `op:N`): a funded devnet wallet. */
async function userFrom(connection: Connection, out: E2eOut, ref: string): Promise<PublicKey> {
  const op = /^op:(\d+)$/.exec(ref)
  const sig = op ? out.ops?.[Number(op[1])]?.signature : out.signatures?.[ref]
  if (!sig) throw new Error(`no signature for ${ref}`)
  const tx = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  if (!tx) throw new Error(`transaction ${sig} not found`)
  const user = tx.transaction.message.staticAccountKeys[0]
  console.log(`USER  fee payer of "${ref}" (${sig.slice(0, 16)}...): ${user.toBase58()}`)
  return user
}

/** Every router market on devnet whose curve is still live (no writes: getProgramAccounts + getMultipleAccounts). */
async function findLiveWsolMarket(connection: Connection): Promise<MarketAccounts | null> {
  const accounts = await connection.getProgramAccounts(ROUTER_ID, { filters: [{ dataSize: MARKET_LEN }] })
  const markets = accounts.map(({ pubkey, account }) => marketFromAccount(pubkey, account.data)).slice(0, MAX_MULTIPLE_ACCOUNTS)
  const pools = await connection.getMultipleAccountsInfo(markets.map((x) => x.pool))
  const live = markets.filter((x, k) => !x.finalized && pools[k]?.data[POOL_MIGRATION_PROGRESS_OFFSET] === 0)
  const liveWsol = live.filter((x) => x.quoteMint.equals(NATIVE_MINT))
  console.log(`LIVE  router ${ROUTER_ID.toBase58()}: ${accounts.length} markets of ${MARKET_LEN} bytes, ` +
    `${live.length} with a live curve, ${liveWsol.length} of them with a wSOL quote`)
  return liveWsol[0] ?? null
}

async function printState(connection: Connection, m: MarketAccounts): Promise<void> {
  console.log(`devnet market ${m.market.toBase58()} (pool ${m.pool.toBase58()}, base mint ${m.baseMint.toBase58()}, quote ${m.quoteMint.toBase58()})`)
  const [market, pool, mint] = await connection.getMultipleAccountsInfo([m.market, m.pool, m.baseMint])
  if (!market || !pool || !mint) throw new Error('market, pool or base mint not found on devnet')
  const hook = getTransferHook(unpackMint(m.baseMint, mint, TOKEN_2022_PROGRAM_ID))
  const finalized = market.data.length === MARKET_LEN ? String(market.data[MARKET_FINALIZED_OFFSET]) : `n/a (old ${market.data.length}-byte layout)`
  const hookProgram = !hook ? 'no extension' : hook.programId.equals(PublicKey.default) ? 'none (revoked at graduation)' : hook.programId.toBase58()
  console.log(`STATE market finalized=${finalized}; pool migration_progress=${pool.data[POOL_MIGRATION_PROGRESS_OFFSET]} (0 = curve live); ` +
    `base mint transfer hook program=${hookProgram}`)
}

async function simulate(connection: Connection, label: string, user: PublicKey, ixs: TransactionInstruction[]): Promise<void> {
  const res = await connection.simulateTransaction(toTx(user, ixs), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
  const logs = res.value.logs ?? []
  console.log(`SIM   ${label}: user ${user.toBase58()}, ${txBytes(user, ixs)} bytes, ` +
    `[${ixs.map((ix) => (ix.programId.equals(ROUTER_ID) ? 'ROUTER' : programName(ix.programId))).join(',')}]`)
  console.log(`      err=${JSON.stringify(res.value.err)} unitsConsumed=${res.value.unitsConsumed ?? 'n/a'} hook invocations=${hookRuns(logs)} log lines=${logs.length}`)
  for (const line of logs.filter((l) => l.includes(HOOK_ID.toBase58()))) console.log(`      hook | ${line}`)
  for (const line of logs.slice(-LOG_TAIL)) console.log(`      | ${line}`)
}

/** Memo before the app's buy (which starts with the compute budget) and memo after it. */
const walletWrapped = (m: MarketAccounts, user: PublicKey) =>
  [memoIx('wallet-before'), ...appBuyIxs(m, user, DEVNET_BUY_AMOUNT), memoIx('wallet-after')]

/** `live`: simulate against the first live wSOL market on the router instead of the file's market (the file then only names the user). */
async function runDevnet(path: string, userRef: string, live: boolean): Promise<void> {
  const { out, m: fileMarket } = marketFromFile(path)
  const connection = new Connection(DEVNET_RPC, 'confirmed')
  const user = await userFrom(connection, out, userRef) // RPC call 1
  const m = live ? await findLiveWsolMarket(connection) : fileMarket // live: RPC calls 2-3
  if (!m) {
    console.log('LIVE  no pre-graduation wSOL market on the devnet router: nothing to simulate')
    return
  }
  await printState(connection, m) // RPC call 2 (live: 4)
  if (!live) {
    const fresh = Keypair.generate().publicKey
    await simulate(connection, 'fresh unfunded payer', fresh, walletWrapped(m, fresh)) // RPC call 3
  }
  await simulate(connection, 'funded devnet user', user, walletWrapped(m, user)) // RPC call 4 (live: 5)
}

const USAGE = 'usage: rsc01_injected_ixs.ts SCENARIOS.json INDEX | --devnet OUT.json USER_REF | --devnet-live OUT.json USER_REF'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--devnet' || args[0] === '--devnet-live') {
    if (!args[1] || !args[2]) throw new Error(USAGE)
    return runDevnet(args[1], args[2], args[0] === '--devnet-live')
  }
  if (!args[0]) throw new Error(USAGE)
  return runLiteSvm(args[0], Number(args[1] ?? 0))
}

main().catch((e) => { console.error(e); process.exit(1) })
