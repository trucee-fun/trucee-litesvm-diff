/**
 * End-to-end Zero-PvP PoC against the real DBC program, on LiteSVM or a live cluster.
 *
 * Usage:
 *   npx tsx src/zpvp_e2e.ts SCENARIOS.json INDEX OUT.json                 # LiteSVM (DBC_SO=... to pick binary)
 *   npx tsx src/zpvp_e2e.ts SCENARIOS.json INDEX OUT.json --rpc env --ops 12  # live cluster, ~/.config/solana/id.json pays
 * `--rpc env` reads the URL from DEVNET_RPC (exit 2 when unset), so the provider key never reaches argv; a literal URL
 * still works for local validators. The URL is never printed or written to OUT.json.
 * Flags: --wsol (quote = native SOL, wrapped client-side), --buy-scale X (multiplies random buy sizes),
 *        --anti-dump (DAMM v2 market-cap fee scheduler preset for the migrated pool)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction, getTransferHook, unpackMint } from '@solana/spl-token'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Chain, TxResult, UsageError, chainLabel, liteSvmChain, loadKeypair, rpcChain, runRpcScript } from './chain'
import {
  ANTI_DUMP_OVERRIDES, CONFIG_SWAP_BASE_AMOUNT_OFFSET, HOOK_ID, HOOK_REJECTION, MARKET_BASIS_SNAPSHOT_OFFSET,
  MARKET_SURPLUS_SNAPSHOT_OFFSET, MARKET_TOTAL_BASIS_OFFSET, MarketFixture, ROUTER_ID, Scenario, ZPVP_DEPLOY, check,
  createMarketFixture, must,
} from './fixture'

/** Anti-Whale (ONC-04) needs >= 5 positions to graduate a curve; 6 leaves headroom. */
const TRADERS = 6
const TRADER_LAMPORTS_LIVE = 30_000_000n // 0.03 SOL: ATAs + position rent + fees
const TRADER_LAMPORTS_SIM = 10n ** 15n
const TX_FEE_RESERVE = 10_000n
/** zpvp_router ANTI_WHALE_BPS: one position may hold at most 20% of the config's swap_base_amount. */
export const ANTI_WHALE_BPS = 2_000n
export const BPS = 10_000n
/** Spread buy size = threshold / GRADUATION_CHUNKS, always by the trader holding the fewest tokens. */
export const GRADUATION_CHUNKS = 100n
const MAX_SPREAD_BUYS = 400

function parseArgs() {
  const args = process.argv.slice(2)
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  const [scenarioPath, indexArg, outPath] = args
  if (!scenarioPath || !outPath) throw new UsageError('usage: zpvp_e2e.ts SCENARIOS.json INDEX OUT.json [--rpc env|URL] [--ops N] [--wsol] [--buy-scale X]')
  return {
    scenarioPath, index: Number(indexArg), outPath, ops: Number(flag('--ops') ?? 120),
    wsol: args.includes('--wsol'), buyScale: Number(flag('--buy-scale') ?? 1), antiDump: args.includes('--anti-dump'),
  }
}

export const tradersPath = (outPath: string) => `${outPath}.traders.json`

let liveCleanup: (() => Promise<void>) | null = null
async function runLiveCleanup(): Promise<void> {
  const cleanup = liveCleanup
  liveCleanup = null
  await cleanup?.()
}

export function zpvpPrograms(): [PublicKey, string][] {
  return [
    [DYNAMIC_BONDING_CURVE_PROGRAM_ID, process.env.DBC_SO ?? 'programs/dbc.so'],
    [HOOK_ID, `${ZPVP_DEPLOY}/zpvp_hook.so`],
    [ROUTER_ID, process.env.ROUTER_SO ?? `${ZPVP_DEPLOY}/zpvp_router.so`],
  ]
}

/** The DBC config's swap_base_amount: the base supply the curve sells before graduation. */
export async function swapBaseAmountOf(chain: Chain, config: PublicKey): Promise<bigint> {
  const data = await chain.accountData(config)
  if (!data || data.length < CONFIG_SWAP_BASE_AMOUNT_OFFSET + 8) throw new Error(`config ${config.toBase58()} not found`)
  return data.readBigUInt64LE(CONFIG_SWAP_BASE_AMOUNT_OFFSET)
}

/** zpvp_router anti_whale_cap: swap_base_amount * ANTI_WHALE_BPS / BPS (floor). */
export const antiWhaleCap = (swapBaseAmount: bigint) => (swapBaseAmount * ANTI_WHALE_BPS) / BPS

/** Index of the smallest value (the first one on ties). */
export function leastHeld(tokens: bigint[]): number {
  return tokens.reduce((best, x, i) => (x < tokens[best] ? i : best), 0)
}

export type SpreadOptions = {
  /** Traders allowed to buy (default: all of the fixture's traders). */
  who?: number[]
  /** Sends one buy of `amount` by trader `i` (default: a plain router buy). */
  buy?: (i: number, amount: bigint) => Promise<TxResult>
  /** Checked before every buy; the spread stops once it returns true (default: the curve completed). */
  done?: () => Promise<boolean>
  maxBuys?: number
}

/**
 * Anti-Whale spread: buys threshold / GRADUATION_CHUNKS at a time, each by the trader in `who` holding the fewest
 * tokens, so no position grows past the cap while the curve fills. Returns the number of buys; throws on a failed
 * buy that left the curve live.
 */
export async function spreadBuys(m: MarketFixture, threshold: bigint, opts: SpreadOptions = {}): Promise<number> {
  const who = opts.who ?? m.traders.map((_, i) => i)
  const buy = opts.buy ?? ((i: number, amount: bigint) => m.chain.send(m.traders[i], m.buyIxs(i, amount)))
  const done = opts.done ?? m.curveDone
  const chunk = threshold / GRADUATION_CHUNKS
  let buys = 0
  for (; buys < (opts.maxBuys ?? MAX_SPREAD_BUYS) && !(await done()); buys++) {
    const i = who[leastHeld(await Promise.all(who.map(async (k) => (await m.readPosition(k)).tokens)))]
    const r = await buy(i, chunk)
    if (!r.ok && !(await m.curveDone())) throw new Error(`spread buy ${buys} by trader ${i} failed: ${r.error}`)
  }
  return buys
}

/** `rpc`: the `--rpc` URL (live cluster), or undefined for LiteSVM. */
async function main(rpc: string | undefined) {
  const { scenarioPath, index, outPath, ops: opCount, wsol, buyScale, antiDump } = parseArgs()
  const scenario: Scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))[index]
  const isLive = rpc !== undefined
  const threshold = BigInt(scenario.migration_quote_threshold)

  const funder = isLive ? loadKeypair() : Keypair.generate()
  const chain: Chain = isLive ? rpcChain(rpc, funder) : liteSvmChain(zpvpPrograms())
  if (!isLive) await chain.fund(funder.publicKey, 10n ** 15n)
  const signatures: Record<string, string> = {}
  // live wSOL: every trader needs real SOL for its share of the graduation buys plus random buys
  // (spread graduation, LiteSVM: peak need per trader <= 1.16 x threshold / TRADERS on seeds 4242 and 500)
  const liveWsolLamports = 2n * threshold / BigInt(TRADERS) + TRADER_LAMPORTS_LIVE
  const m = await createMarketFixture(chain, funder, scenario, {
    wsol, traderCount: TRADERS, signatures, configOverrides: antiDump ? ANTI_DUMP_OVERRIDES : undefined,
    traderLamports: !isLive ? TRADER_LAMPORTS_SIM : wsol ? liveWsolLamports : TRADER_LAMPORTS_LIVE,
    // live: persist trader keys before funding so `sweep_traders.ts` can recover SOL if the run dies
    onTraders: isLive ? (ts) => writeFileSync(tradersPath(outPath), JSON.stringify(ts.map((t) => Array.from(t.secretKey)))) : undefined,
  })
  const { traders, ata, readPosition, balanceOf, positionOf } = m

  const cuLog: Record<string, bigint[]> = {}
  const logged = (k: string, r: TxResult) => { if (r.ok) (cuLog[k] ??= []).push(r.cu); return r }
  // wSOL: refunds come back as wSOL, so only wrap the shortfall
  const routerBuy = async (i: number, amount: bigint) => {
    const held = wsol ? await balanceOf(ata[i].quote) : amount
    return logged('router buy', await chain.send(traders[i], m.buyIxs(i, amount, {}, held >= amount ? 0n : amount - held)))
  }
  if (isLive) liveCleanup = async () => { // unwrap wSOL and return leftover SOL to the funder, also when a check throws
    for (const [i, t] of traders.entries()) {
      if (wsol) await chain.send(t, [createCloseAccountInstruction(ata[i].quote, t.publicKey, t.publicKey)])
      const leftover = (await chain.lamports(t.publicKey)) - TX_FEE_RESERVE
      if (leftover > 0n) await chain.send(t, [SystemProgram.transfer({ fromPubkey: t.publicKey, toPubkey: funder.publicKey, lamports: leftover + TX_FEE_RESERVE - 5_000n })])
    }
  }
  const routerSell = async (i: number, tokens: bigint) => logged('router sell', await chain.send(traders[i], [m.sellIx(i, tokens)]))

  // ===== 1. direct DBC buy is blocked by the hook
  const direct = await chain.send(traders[0], await m.directDbcBuyIxs(0, 10n ** 8n))
  check(!direct.ok && HOOK_REJECTION.test(direct.error), 'direct DBC buy (bypassing router) is rejected by the hook',
    direct.ok ? 'succeeded!' : direct.error.slice(0, 120))

  // ===== 2. router buy lands tokens in the user's own wallet
  const firstBuyAmount = threshold / 20n < 10n ** 9n ? threshold / 20n : 10n ** 9n
  const vaultBefore = await balanceOf(m.quoteVault)
  const firstBuy = await routerBuy(0, firstBuyAmount)
  must(firstBuy, 'router buy')
  if (firstBuy.ok && firstBuy.signature) signatures['first router buy'] = firstBuy.signature
  const pos0 = await readPosition(0)
  check((await balanceOf(ata[0].base)) === pos0.tokens && pos0.tokens > 0n, 'router buy: tokens are in the user wallet ATA', `${pos0.tokens} raw`)
  check((await balanceOf(m.quoteVault)) - vaultBefore === firstBuyAmount, 'router buy: pool received exactly amount_in from the user')

  // ===== 3. wallet-to-wallet transfer is blocked
  const xfer = await chain.send(traders[0], [m.transferIx(0, 1, pos0.tokens / 2n, true)])
  check(!xfer.ok && HOOK_REJECTION.test(xfer.error), 'wallet-to-wallet transfer before graduation is rejected by the hook',
    xfer.ok ? 'succeeded!' : xfer.error.slice(0, 120))

  // ===== 4+5. random router sequence, recorded for the Python replay
  type Op = { kind: 'buy' | 'sell'; trader: number; amount: string; ok: boolean; tokens_out?: string; refund?: string; basis_after?: string; error?: string; signature?: string }
  const ops: Op[] = []
  let seed = scenario.seed * 31 + 7
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let n = 0; n < opCount; n++) {
    const i = Math.floor(rand() * TRADERS)
    const pos = await readPosition(i)
    if (pos.tokens > 0n && rand() < 0.45) {
      const tokens = rand() < 0.5 ? pos.tokens : BigInt(Math.max(1, Math.floor(Number(pos.tokens) * rand())))
      const qBefore = await balanceOf(ata[i].quote)
      const r = await routerSell(i, tokens)
      ops.push({ kind: 'sell', trader: i, amount: tokens.toString(), ok: r.ok, error: r.ok ? undefined : r.error, signature: r.ok ? r.signature : undefined,
        refund: ((await balanceOf(ata[i].quote)) - qBefore).toString(), basis_after: (await readPosition(i)).basis.toString() })
    } else {
      const amount = BigInt(Math.max(1, Math.floor(10 ** (rand() * 3.3 - 2) * 1e9 * buyScale))) // 0.01 .. 20 quote × scale
      const bBefore = await balanceOf(ata[i].base)
      const r = await routerBuy(i, amount)
      ops.push({ kind: 'buy', trader: i, amount: amount.toString(), ok: r.ok, error: r.ok ? undefined : r.error, signature: r.ok ? r.signature : undefined,
        tokens_out: ((await balanceOf(ata[i].base)) - bBefore).toString(), basis_after: (await readPosition(i)).basis.toString() })
    }
  }
  const okOps = ops.filter((o) => o.ok)
  check(okOps.length > 0, 'random router sequence executed',
    `${okOps.length}/${ops.length} ok, buys=${okOps.filter((o) => o.kind === 'buy').length} sells=${okOps.filter((o) => o.kind === 'sell').length}`)
  console.log(`      buffer vault after sequence: ${await balanceOf(m.buffer)} lamports`)

  if (!(await m.curveDone())) {
    const early = await chain.send(funder, [m.finalizeIx()])
    check(!early.ok, 'finalize before graduation is rejected', early.ok ? 'succeeded!' : early.error.slice(0, 100))
  } else {
    console.log('SKIP  finalize-before-graduation check (curve already completed during the random sequence)')
  }

  // ===== 6. drive to graduation through the router (spread so no position passes the Anti-Whale cap), then the hook must be gone
  const graduationBuys = await spreadBuys(m, threshold, { buy: routerBuy })
  const graduated = await m.curveDone()
  const cap = antiWhaleCap(await swapBaseAmountOf(chain, m.config.publicKey))
  const largest = (await Promise.all(traders.map((_, i) => readPosition(i)))).reduce((a, p) => (p.tokens > a ? p.tokens : a), 0n)
  const mintData = (await chain.accountData(m.baseMint.publicKey))!
  const mintInfo = unpackMint(m.baseMint.publicKey, { data: mintData, owner: TOKEN_2022_PROGRAM_ID, lamports: 0, executable: false } as never, TOKEN_2022_PROGRAM_ID)
  const hook = getTransferHook(mintInfo)
  check(graduated && largest <= cap, 'curve completed via router buys',
    `${graduationBuys} buys of ${threshold / GRADUATION_CHUNKS}, largest position ${largest} <= cap ${cap}`)
  check(!!hook && hook.programId.equals(PublicKey.default), 'DBC revoked the transfer hook at graduation', hook?.programId.toBase58())

  // ===== 7. surplus: finalize snapshots the buffer, holders claim pro-rata to basis, positions close
  const positionsBasis = (await Promise.all(traders.map((_, i) => readPosition(i)))).reduce((a, p) => a + p.basis, 0n)
  const marketBefore = (await chain.accountData(m.market))!
  check(marketBefore.readBigUInt64LE(MARKET_TOTAL_BASIS_OFFSET) === positionsBasis, 'market.total_basis == sum of position basis', `${positionsBasis}`)
  const bufferAtGrad = await balanceOf(m.buffer)
  await m.step('router: finalize', funder, [m.finalizeIx()])
  const marketData = (await chain.accountData(m.market))!
  const surplus = marketData.readBigUInt64LE(MARKET_SURPLUS_SNAPSHOT_OFFSET)
  const basisSnapshot = marketData.readBigUInt64LE(MARKET_BASIS_SNAPSHOT_OFFSET)
  check(surplus === bufferAtGrad && basisSnapshot === positionsBasis, 'finalize snapshots surplus = buffer balance', `surplus=${surplus}`)

  const holders: number[] = []
  for (let i = 0; i < TRADERS; i++) if (await chain.accountData(positionOf(i))) holders.push(i)
  // the first holder claims for themselves; a third-party crank (the funder) claims for everyone else
  const claims: { trader: number; basis: string; share: string; by: string }[] = []
  let claimsOk = true
  let crankRentOk = true
  for (const [k, i] of holders.entries()) {
    const viaCrank = k > 0
    const { basis } = await readPosition(i)
    const before = await balanceOf(ata[i].quote)
    const ownerLamports = await chain.lamports(traders[i].publicKey)
    const positionRent = await chain.lamports(positionOf(i))
    if (viaCrank) must(await chain.send(funder, [m.claimIx(funder.publicKey, i)]), `crank claim ${i}`)
    else must(await chain.send(traders[i], [m.claimIx(traders[i].publicKey, i)]), `claim ${i}`)
    const share = (await balanceOf(ata[i].quote)) - before
    const expected = basisSnapshot === 0n ? 0n : (surplus * basis) / basisSnapshot
    claimsOk &&= share === expected && (await chain.accountData(positionOf(i))) === null
    if (viaCrank) crankRentOk &&= (await chain.lamports(traders[i].publicKey)) === ownerLamports + positionRent
    claims.push({ trader: i, basis: basis.toString(), share: share.toString(), by: viaCrank ? 'crank' : 'owner' })
  }
  if (holders.length > 1) check(crankRentOk, 'crank claims: position rent returned to the owner, not the crank', `${holders.length - 1} via crank`)
  const residual = await balanceOf(m.buffer)
  const paid = claims.reduce((a, c) => a + BigInt(c.share), 0n)
  check(claimsOk, 'each holder claimed exactly surplus*basis/total and its position closed', `${holders.length} holders`)
  check(paid + residual === surplus && residual < BigInt(TRADERS), 'claims exhaust the surplus (residual = rounding dust)', `paid=${paid} residual=${residual}`)

  let holder = -1
  for (let i = 0; i < TRADERS && holder < 0; i++) if ((await balanceOf(ata[i].base)) > 0n) holder = i
  const freeXfer = await chain.send(traders[holder], [m.transferIx(holder, (holder + 1) % TRADERS, 1n, false)])
  check(freeXfer.ok, 'after graduation: plain wallet transfer works (token is free)', freeXfer.ok ? '' : freeXfer.error.slice(0, 120))
  const lateSell = await routerSell(holder, 1n)
  check(!lateSell.ok, 'after graduation: selling into the curve is rejected (PoolIsCompleted)')

  for (const [k, v] of Object.entries(cuLog)) {
    const sorted = [...v].sort((a, b) => (a < b ? -1 : 1))
    console.log(`CU    ${k}: n=${v.length} median=${sorted[Math.floor(v.length / 2)]} max=${sorted[v.length - 1]}`)
  }
  await runLiveCleanup()
  writeFileSync(outPath, JSON.stringify({
    wsol, surplus: surplus.toString(), claims,
    chain: chainLabel(rpc), seed: scenario.seed, accounts: {
      config: m.config.publicKey.toBase58(), pool: m.pool.toBase58(), base_mint: m.baseMint.publicKey.toBase58(),
      quote_mint: m.quoteMintPk.toBase58(), market: m.market.toBase58(), buffer: m.buffer.toBase58(),
    }, signatures, ops,
  }, null, 1))
}

if (require.main === module) runRpcScript(main, runLiveCleanup)
