/**
 * xStock (Token-2022) quote market end to end on LiteSVM, against the capped router build: a TSLAx-quoted Zero-PvP
 * market from init_market through exit-at-cost, graduation, finalize and claims, plus the `market` field of the
 * router events. TSLAx mint + DBC token badge are mainnet snapshots (fixtures/mainnet); we hold no mint authority,
 * so traders get TSLAx by rewriting their ATA balance. Negatives (each rejected with its exact code, nothing moved):
 * exit above the position, a direct base-token transfer before graduation, a claim before finalize, a double claim,
 * plus the fixture guards (snapshot owners, badge mint, setTokenAmount refusing program-held accounts).
 *
 * Usage: npx tsx src/zpvp_xstocks.ts SCENARIOS.json INDEX   (ROUTER_SO=... to pick the router binary)
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getExtensionTypes, getTransferHook, unpackMint,
} from '@solana/spl-token'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID, deriveTokenBadgeAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Chain, TxResult, liteSvmChain } from './chain'
import {
  CONFIG_SWAP_BASE_AMOUNT_OFFSET, HOOK_ID, MAINNET_FIXTURE_DIR, MARKET_BASIS_SNAPSHOT_OFFSET, MARKET_SURPLUS_SNAPSHOT_OFFSET,
  MARKET_TOTAL_BASIS_OFFSET, MarketFixture, POOL_QUOTE_RESERVE_OFFSET, Scenario, XSTOCKS, anchorError, check, createMarketFixture,
  loadXStockQuote, must, setTokenAmount,
} from './fixture'
import { zpvpPrograms } from './zpvp_e2e'

/** >= 6: anti-whale (ONC-04) caps one position at 20% of swap_base_amount, so graduation needs spread buys. */
const TRADERS = 8
const TSLAX_PER_TRADER = 2n * 10n ** 8n // 2 TSLAx at 8 decimals
const TRADER_LAMPORTS = 10n ** 12n
// The curve is steep at the start (1/30 of the threshold buys ~13% of swap_base_amount), so buys stay small and
// each graduation buy goes to the trader holding the fewest tokens.
const FIRST_BUY_DIVISOR = 100n // first buy and the price-raising buy = threshold / 100
const GRADUATION_STEP_DIVISOR = 64n // graduation buy = threshold / 64
const MAX_GRADUATION_BUYS = 400
const ANTI_WHALE_BPS = 2_000n
const BPS = 10_000n
// zpvp_router math.rs
const FEE_DENOMINATOR = 1_000_000_000n
const DUST_PER_BUY = 16n
const HAIRCUT_PER_EXIT = 2n
// Market (borsh): disc 8 | pool | config | base_mint | quote_mint | base_vault | quote_vault | buffer_vault | fee u64 | ...
const MARKET_QUOTE_MINT_OFFSET = 104
const MARKET_BUFFER_VAULT_OFFSET = 200
const MARKET_FEE_OFFSET = 232
const TOKEN_ACCOUNT_LEN = 165
const ACCOUNT_TYPE_ACCOUNT = 2 // Token-2022 AccountType::Account, the byte after the 165-byte base layout
const PROGRAM_DATA = 'Program data: '
/** Balance setTokenAmount is asked to write into accounts it must refuse (any change would show). */
const PROBE_AMOUNT = 1n

type Rejection = readonly [code: number, name: string]
/** Exact rejections: zpvp_hook HookError, zpvp_router RouterError, and Anchor's error for a closed (missing) position. */
const ERR = {
  transferNotViaRouter: [6000, 'TransferNotViaRouter'],
  invalidExitAmount: [6007, 'InvalidExitAmount'],
  notFinalized: [6011, 'NotFinalized'],
  accountNotInitialized: [3012, 'AccountNotInitialized'],
} as const satisfies Record<string, Rejection>

type EventName = 'BuyEvent' | 'SellEvent' | 'ClaimEvent'
type AccountFixtureFile = { address: string; owner: string; lamports: number; executable: boolean; data: string }

/** refund_for(basis, fee) = basis - ceil(basis * fee / 1e9) - 2, floored at zero (math.rs). */
function refundFor(basis: bigint, fee: bigint): bigint {
  const feeAtCost = (basis * fee + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR
  const refund = basis - feeAtCost - HAIRCUT_PER_EXIT
  return refund > 0n ? refund : 0n
}

/** Anchor `emit!` payloads (`Program data:` logs) of one event type: 8-byte discriminator, then the borsh fields. */
function eventsOf(r: TxResult, name: EventName): Buffer[] {
  if (!r.ok) return []
  const disc = createHash('sha256').update(`event:${name}`).digest().subarray(0, 8)
  return (r.logs ?? [])
    .filter((l) => l.startsWith(PROGRAM_DATA))
    .map((l) => Buffer.from(l.slice(PROGRAM_DATA.length), 'base64'))
    .filter((d) => d.length >= 40 && d.subarray(0, 8).equals(disc))
}

const u64At = (d: Buffer, offset: number) => d.readBigUInt64LE(offset)
const keyAt = (d: Buffer, offset: number) => new PublicKey(d.subarray(offset, offset + 32))
/** Index of the trader holding the fewest tokens (first one on ties). */
const smallestHolder = (positions: { tokens: bigint }[]) =>
  positions.reduce((best, p, i) => (p.tokens < positions[best].tokens ? i : best), 0)

async function readAccount(chain: Chain, address: PublicKey, what: string): Promise<Buffer> {
  const data = await chain.accountData(address)
  if (!data) throw new Error(`${what} ${address.toBase58()} does not exist`)
  return data
}

/** The base mint's Token-2022 transfer-hook program (PublicKey.default once DBC revokes it), or null without the extension. */
async function transferHookOf(chain: Chain, mint: PublicKey): Promise<PublicKey | null> {
  const data = await readAccount(chain, mint, 'mint')
  const info = unpackMint(mint, { data, owner: TOKEN_2022_PROGRAM_ID, lamports: 0, executable: false }, TOKEN_2022_PROGRAM_ID)
  return getTransferHook(info)?.programId ?? null
}

/** Hex of every watched account: equal before and after means a rejected transaction moved no funds and changed no state. */
const stateOf = (chain: Chain, accounts: PublicKey[]) =>
  Promise.all(accounts.map(async (a) => (await chain.accountData(a))?.toString('hex') ?? 'missing'))

/** Sends, then asserts the exact Anchor error of instruction 0 and that no watched account changed. */
async function rejectedUnchanged(
  chain: Chain, watched: PublicKey[], send: () => Promise<TxResult>, [code, name]: Rejection, label: string,
): Promise<void> {
  const before = await stateOf(chain, watched)
  const r = await send()
  const unchanged = (await stateOf(chain, watched)).every((d, k) => d === before[k])
  const matches = !r.ok && anchorError(code, name).test(r.error)
  check(matches && unchanged, `${label} rejected ${code} ${name}, no balance change`,
    `${unchanged ? '' : 'STATE CHANGED '}${r.ok ? 'SUCCEEDED (vulnerable!)' : r.error.replace(/\s+/g, ' ').slice(0, 110)}`)
}

/** The message `f` throws (sync or async), or null if it returns. */
async function thrownBy(f: () => unknown): Promise<string | null> {
  try {
    await f()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const readFixtureFile = (address: PublicKey): AccountFixtureFile =>
  JSON.parse(readFileSync(`${MAINNET_FIXTURE_DIR}/${address.toBase58()}.json`, 'utf8'))

/**
 * loadXStockQuote refuses TSLAx snapshots that are another account, whose mint is not Token-2022's, whose badge is not
 * DBC's, or whose badge names another mint; each with the guard's own message.
 */
async function checkFixtureGuards(chain: Chain): Promise<void> {
  const [mint, nvdax] = [XSTOCKS.TSLAx, XSTOCKS.NVDAx]
  const badge = deriveTokenBadgeAddress(mint)
  const [realMint, realBadge] = [readFixtureFile(mint), readFixtureFile(badge)]
  const [nvdaxMint, nvdaxBadge] = [readFixtureFile(nvdax), readFixtureFile(deriveTokenBadgeAddress(nvdax))]
  // base58 has no regex metacharacters, so keys go into the patterns verbatim
  const cases: [string, AccountFixtureFile, AccountFixtureFile, RegExp][] = [
    ["NVDAx's mint snapshot in the TSLAx mint file (wrong address)", nvdaxMint, realBadge, new RegExp(`: address is ${nvdax}$`)],
    ['a TSLAx mint owned by SPL Token, not Token-2022', { ...realMint, owner: TOKEN_PROGRAM_ID.toBase58() }, realBadge,
      new RegExp(`: owner is ${TOKEN_PROGRAM_ID}, expected ${TOKEN_2022_PROGRAM_ID}$`)],
    ['a TSLAx badge owned by Token-2022, not DBC', realMint, { ...realBadge, owner: TOKEN_2022_PROGRAM_ID.toBase58() },
      new RegExp(`: owner is ${TOKEN_2022_PROGRAM_ID}, expected ${DYNAMIC_BONDING_CURVE_PROGRAM_ID}$`)],
    ["NVDAx's badge at the TSLAx badge address (data[8..40] = NVDAx)", realMint, { ...nvdaxBadge, address: badge.toBase58() },
      new RegExp(`: token badge mint at byte 8 is ${nvdax}, expected ${mint}$`)],
  ]
  const root = mkdtempSync(join(tmpdir(), 'zpvp-fixtures-'))
  try {
    for (const [k, [label, mintFile, badgeFile, expected]] of cases.entries()) {
      const dir = join(root, `case${k}`)
      mkdirSync(dir)
      writeFileSync(join(dir, `${mint.toBase58()}.json`), JSON.stringify(mintFile))
      writeFileSync(join(dir, `${badge.toBase58()}.json`), JSON.stringify(badgeFile))
      const error = await thrownBy(() => loadXStockQuote(chain, 'TSLAx', dir))
      check(error !== null && expected.test(error), `fixture loader refuses ${label}`, error?.replace(`${dir}/`, '') ?? 'loaded!')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * setTokenAmount rewrites only a wallet's ATA under its own token program: never the buffer or a pool vault. Each
 * refusal must come from the matching guard (its message), not from any unrelated throw.
 */
async function checkTokenAmountGuards(m: MarketFixture, quoteProgram: PublicKey): Promise<void> {
  const heldByProgram = (account: PublicKey) => new RegExp(`^setTokenAmount: ${account} is held by a program \\(authority \\w+ is a PDA\\)`)
  const trader0Quote = m.ata[0].quote
  const cases: [string, PublicKey, PublicKey, RegExp][] = [
    ['the market buffer vault', m.buffer, quoteProgram, heldByProgram(m.buffer)],
    ['the pool quote vault', m.quoteVault, quoteProgram, heldByProgram(m.quoteVault)],
    ['the pool base vault', m.baseVault, TOKEN_2022_PROGRAM_ID, heldByProgram(m.baseVault)],
    ["a trader's TSLAx ATA named under SPL Token (wrong token program)", trader0Quote, TOKEN_PROGRAM_ID,
      new RegExp(`^setTokenAmount: ${trader0Quote} is not the ${TOKEN_PROGRAM_ID} ATA of ${m.traders[0].publicKey} for ${m.quoteMintPk}`)],
  ]
  for (const [label, account, program, expected] of cases) {
    const [before] = await stateOf(m.chain, [account])
    const error = await thrownBy(() => setTokenAmount(m.chain, account, program, PROBE_AMOUNT))
    const [after] = await stateOf(m.chain, [account])
    check(error !== null && expected.test(error) && before === after, `setTokenAmount refuses ${label}, no balance change`,
      `${before === after ? '' : 'STATE CHANGED '}${error ?? 'rewritten!'}`)
  }
}

function parseArgs(): { scenario: Scenario } {
  const [scenarioPath, indexArg] = process.argv.slice(2)
  if (!scenarioPath) throw new Error('usage: zpvp_xstocks.ts SCENARIOS.json [INDEX]')
  const scenarios: Scenario[] = JSON.parse(readFileSync(scenarioPath, 'utf8'))
  const index = Number(indexArg ?? 0)
  const scenario = scenarios[index]
  if (!Number.isInteger(index) || !scenario) throw new Error(`no scenario at index ${indexArg} in ${scenarioPath}`)
  return { scenario }
}

/** The buffer vault: a Token-2022 TSLAx account whose authority is the market PDA, recorded in the market. */
async function checkBufferVault(m: MarketFixture, quoteMint: PublicKey): Promise<void> {
  const vault = await readAccount(m.chain, m.buffer, 'buffer vault')
  const market = await readAccount(m.chain, m.market, 'market')
  const extensions = vault.length > TOKEN_ACCOUNT_LEN ? getExtensionTypes(vault.subarray(TOKEN_ACCOUNT_LEN + 1)) : []
  const isToken2022Account = vault[TOKEN_ACCOUNT_LEN] === ACCOUNT_TYPE_ACCOUNT &&
    extensions.includes(ExtensionType.TransferHookAccount) && extensions.includes(ExtensionType.PausableAccount)
  check(isToken2022Account && keyAt(vault, 0).equals(quoteMint) && keyAt(vault, 32).equals(m.market) &&
    keyAt(market, MARKET_QUOTE_MINT_OFFSET).equals(quoteMint) && keyAt(market, MARKET_BUFFER_VAULT_OFFSET).equals(m.buffer),
  'buffer vault is a Token-2022 TSLAx account owned by the market PDA',
  `len=${vault.length} ext=[${extensions.map((e) => ExtensionType[e]).join(',')}] authority=${keyAt(vault, 32).toBase58().slice(0, 8)}`)
}

async function main() {
  const { scenario } = parseArgs()
  const threshold = BigInt(scenario.migration_quote_threshold)
  const chain = liteSvmChain(zpvpPrograms())
  const admin = Keypair.generate()
  await chain.fund(admin.publicKey, 10n ** 16n)
  const events: Record<EventName, Buffer[]> = { BuyEvent: [], SellEvent: [], ClaimEvent: [] }
  const txCount: Record<EventName, number> = { BuyEvent: 0, SellEvent: 0, ClaimEvent: 0 }
  const record = (name: EventName, r: TxResult) => { if (r.ok) { txCount[name] += 1; events[name].push(...eventsOf(r, name)) } return r }

  // ===== 0. the router under test must be the capped build, or "accepts TSLAx" proves nothing
  const probe = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: 0, traderLamports: 0n, skipMarket: true })
  const probeRes = await chain.send(admin, [probe.initMarketIx()])
  check(!probeRes.ok && anchorError(6017, 'QuoteMintNotAllowed').test(probeRes.error), 'router is the capped build (custom quote mint rejected 6017)',
    probeRes.ok ? 'accepted!' : '')

  // ===== 1. TSLAx (mainnet Token-2022 mint + DBC token badge) as the quote of a transfer-hook pool
  await checkFixtureGuards(chain)
  const tslax = loadXStockQuote(chain, 'TSLAx')
  const m = await createMarketFixture(chain, admin, scenario, {
    wsol: false, traderCount: TRADERS, traderLamports: TRADER_LAMPORTS, skipMarket: true, quote: tslax })
  const { traders, ata, balanceOf, readPosition, positionOf } = m
  for (const a of ata) await setTokenAmount(chain, a.quote, tslax.tokenProgram, TSLAX_PER_TRADER)
  const init = await chain.send(admin, [m.initMarketIx()])
  check(init.ok, 'init_market accepts TSLAx on the capped build', init.ok ? `threshold ${threshold} raw` : init.error.slice(0, 160))
  must(init, 'init_market (TSLAx)')
  await checkBufferVault(m, tslax.mint)
  await checkTokenAmountGuards(m, tslax.tokenProgram)
  const fee = u64At(await readAccount(chain, m.market, 'market'), MARKET_FEE_OFFSET)

  // ===== 2. buy records basis = net quote into the curve - DUST_PER_BUY
  const reserve = async () => u64At(await readAccount(chain, m.pool, 'pool'), POOL_QUOTE_RESERVE_OFFSET)
  const firstBuy = threshold / FIRST_BUY_DIVISOR
  const [reserveBefore, quoteBefore] = [await reserve(), await balanceOf(ata[0].quote)]
  const buy0 = record('BuyEvent', await chain.send(traders[0], m.buyIxs(0, firstBuy)))
  must(buy0, 'trader 0 buy')
  const netIntoCurve = (await reserve()) - reserveBefore
  const pos0 = await readPosition(0)
  const [buyEv] = eventsOf(buy0, 'BuyEvent')
  const totalBasis = u64At(await readAccount(chain, m.market, 'market'), MARKET_TOTAL_BASIS_OFFSET)
  check(pos0.basis === netIntoCurve - DUST_PER_BUY && pos0.tokens > 0n && totalBasis === pos0.basis &&
    quoteBefore - (await balanceOf(ata[0].quote)) === firstBuy && (await balanceOf(ata[0].base)) === pos0.tokens &&
    !!buyEv && keyAt(buyEv, 40).equals(traders[0].publicKey) && u64At(buyEv, 72) === pos0.tokens &&
    u64At(buyEv, 80) === netIntoCurve && u64At(buyEv, 88) === pos0.basis,
  'buy records basis', `amount_in=${firstBuy} net_into_curve=${netIntoCurve} basis=${pos0.basis} tokens=${pos0.tokens}`)

  // ===== 2b. before graduation a position leaves only by an exit at cost of at most its tokens
  const watched01 = [m.positionOf(0), m.positionOf(1), m.market, m.buffer, ata[0].quote, ata[0].base, ata[1].quote, ata[1].base,
    m.pool, m.baseVault, m.quoteVault, m.baseMint.publicKey]
  await rejectedUnchanged(chain, watched01, () => chain.send(traders[0], [m.sellIx(0, pos0.tokens + 1n)]), ERR.invalidExitAmount,
    'exit of one token more than the position')
  await rejectedUnchanged(chain, watched01, () => chain.send(traders[0], [m.transferIx(0, 1, pos0.tokens, true)]),
    ERR.transferNotViaRouter, 'direct wallet-to-wallet base-token transfer before graduation (hook)')

  // ===== 3. the price rises (trader 1 buys), trader 0 exits at cost: refund_for(basis, fee) in TSLAx, gain stays in the buffer
  must(record('BuyEvent', await chain.send(traders[1], m.buyIxs(1, firstBuy))), 'trader 1 buy')
  const [q0, buf0] = [await balanceOf(ata[0].quote), await balanceOf(m.buffer)]
  const sell0 = record('SellEvent', await chain.send(traders[0], [m.sellIx(0, pos0.tokens)]))
  must(sell0, 'trader 0 exit at cost')
  const refund = (await balanceOf(ata[0].quote)) - q0
  const expectedRefund = refundFor(pos0.basis, fee)
  const [sellEv] = eventsOf(sell0, 'SellEvent')
  const proceeds = sellEv ? u64At(sellEv, 88) : -1n
  const after0 = await readPosition(0)
  check(refund === expectedRefund && !!sellEv && u64At(sellEv, 72) === pos0.tokens && u64At(sellEv, 80) === pos0.basis &&
    u64At(sellEv, 96) === refund && (await balanceOf(m.buffer)) === buf0 + proceeds - refund &&
    after0.tokens === 0n && after0.basis === 0n && proceeds > refund,
  'exit-at-cost pays exactly refund_for(basis, fee) in TSLAx',
  `basis=${pos0.basis} fee=${fee} refund=${refund} expected=${expectedRefund} proceeds=${proceeds}`)

  // ===== 4. graduate through router buys spread over all traders (the smallest holder buys next)
  const step = threshold / GRADUATION_STEP_DIVISOR
  const readPositions = () => Promise.all(traders.map((_, i) => readPosition(i)))
  const hookBefore = await transferHookOf(chain, m.baseMint.publicKey)
  for (let k = 0; k < MAX_GRADUATION_BUYS && !(await m.curveDone()); k++) {
    const i = smallestHolder(await readPositions())
    must(record('BuyEvent', await chain.send(traders[i], m.buyIxs(i, step))), `graduation buy ${k} (trader ${i})`)
  }
  const positions = await readPositions()
  const swapBaseAmount = u64At(await readAccount(chain, m.config.publicKey, 'config'), CONFIG_SWAP_BASE_AMOUNT_OFFSET)
  const largest = positions.reduce((a, p) => (p.tokens > a ? p.tokens : a), 0n)
  const holdersWithTokens = positions.filter((p) => p.tokens > 0n).length
  check(await m.curveDone(), 'curve completed via router buys')
  check(holdersWithTokens >= 6 && largest * BPS <= swapBaseAmount * ANTI_WHALE_BPS,
    'graduation spread: >= 6 holders, no position above 20% of swap_base_amount (ONC-04 ready)',
    `holders=${holdersWithTokens} largest=${(Number(largest * BPS) / Number(swapBaseAmount) / 100).toFixed(2)}% of ${swapBaseAmount}`)
  const hookAfter = await transferHookOf(chain, m.baseMint.publicKey)
  check(!!hookBefore?.equals(HOOK_ID) && !!hookAfter?.equals(PublicKey.default), 'graduation revokes the hook',
    `${hookBefore?.toBase58().slice(0, 8)} -> ${hookAfter?.toBase58().slice(0, 8)}`)

  // ===== 5. finalize freezes the buffer as surplus; every holder claims pro-rata in TSLAx, once
  const claimWatched = (i: number) => [m.positionOf(i), m.market, m.buffer, ata[i].quote]
  const claimBy = (i: number) => () => chain.send(traders[i], [m.claimIx(traders[i].publicKey, i)])
  // trader 1 bought in step 3 and never sold, so its position is open
  await rejectedUnchanged(chain, claimWatched(1), claimBy(1), ERR.notFinalized, 'claim after graduation, before finalize')
  const positionsBasis = positions.reduce((a, p) => a + p.basis, 0n)
  const bufferAtGrad = await balanceOf(m.buffer)
  must(await chain.send(admin, [m.finalizeIx()]), 'finalize')
  const marketData = await readAccount(chain, m.market, 'market')
  const surplus = u64At(marketData, MARKET_SURPLUS_SNAPSHOT_OFFSET)
  const basisSnapshot = u64At(marketData, MARKET_BASIS_SNAPSHOT_OFFSET)
  check(surplus === bufferAtGrad && basisSnapshot === positionsBasis && surplus > 0n, 'finalize snapshot == buffer balance',
    `surplus=${surplus} basis_snapshot=${basisSnapshot}`)

  const holders: number[] = []
  for (const i of traders.keys()) if (await chain.accountData(positionOf(i))) holders.push(i)
  let paid = 0n
  let claimsOk = true
  for (const i of holders) {
    const before = await balanceOf(ata[i].quote)
    const claim = record('ClaimEvent', await claimBy(i)())
    must(claim, `claim ${i}`)
    const share = (await balanceOf(ata[i].quote)) - before
    const [claimEv] = eventsOf(claim, 'ClaimEvent')
    claimsOk &&= share === (surplus * positions[i].basis) / basisSnapshot && !!claimEv && u64At(claimEv, 80) === share &&
      keyAt(claimEv, 40).equals(traders[i].publicKey) && (await chain.accountData(positionOf(i))) === null
    paid += share
    // the first claimer tries again while the buffer still holds everyone else's surplus
    if (i === holders[0]) {
      await rejectedUnchanged(chain, claimWatched(i), claimBy(i), ERR.accountNotInitialized, 'double claim (position closed by the first)')
    }
  }
  const residual = await balanceOf(m.buffer)
  check(claimsOk, 'each holder claimed exactly surplus*basis/total in TSLAx and its position closed', `${holders.length} holders`)
  check(paid + residual === surplus && residual <= BigInt(holders.length), 'claims exhaust the surplus (residual <= holder count)',
    `paid=${paid} residual=${residual}`)
  const traderTotal = (await Promise.all(ata.map((a) => balanceOf(a.quote)))).reduce((a, b) => a + b, 0n)
  check(traderTotal + (await balanceOf(m.quoteVault)) + residual === TSLAX_PER_TRADER * BigInt(TRADERS),
    'TSLAx conserved across traders, pool quote vault and buffer')

  // ===== 6. every router event names this market (bytes 8..40, right after the 8-byte discriminator)
  const names: EventName[] = ['BuyEvent', 'SellEvent', 'ClaimEvent']
  const allNameMarket = names.every((n) => events[n].length > 0 && events[n].length === txCount[n] &&
    events[n].every((e) => e.subarray(8, 40).equals(m.market.toBuffer())))
  check(allNameMarket, '`market` in BuyEvent/SellEvent/ClaimEvent == market PDA',
    names.map((n) => `${n}=${events[n].length}/${txCount[n]}`).join(' '))
}

main().catch((e) => { console.error(e); process.exit(1) })
