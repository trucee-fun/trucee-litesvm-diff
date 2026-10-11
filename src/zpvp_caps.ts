/**
 * Mainnet-beta launch caps, run against the default (capped) router build: only allowlisted quote mints, each with a
 * graduation threshold cap (wSOL 10 SOL, TSLAx 5 shares, NVDAx 10 shares). xStocks are mainnet Token-2022 snapshots.
 *
 * Usage: ROUTER_SO=programs/router_capped.so npx tsx src/zpvp_caps.ts SCENARIOS.json SMALL_SCENARIO.json
 */
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { MINT_SIZE, TOKEN_2022_PROGRAM_ID, createInitializeMint2Instruction } from '@solana/spl-token'
import { Chain, TxResult, liteSvmChain } from './chain'
import { QuoteOptions, Scenario, XStock, anchorError, check, createMarketFixture, loadXStockQuote, must } from './fixture'
import { zpvpPrograms } from './zpvp_e2e'

const MAX_THRESHOLD = 10_000_000_000n
/** zpvp_router QUOTE_CAPS for the xStocks (raw units, 8 decimals). */
const XSTOCK_CAPS: [XStock, bigint][] = [['TSLAx', 500_000_000n], ['NVDAx', 1_000_000_000n]]
const XSTOCK_DECIMALS = 8

function result(r: TxResult, label: string, expected: RegExp | null): void {
  const ok = expected === null ? r.ok : !r.ok && expected.test(r.error)
  check(ok, label, r.ok ? 'accepted' : r.error.replace(/\s+/g, ' ').slice(0, 100))
}

/** A fresh Token-2022 mint with no extensions: a valid DBC quote, but not on the router allowlist. */
async function createToken2022Mint(chain: Chain, admin: Keypair, decimals: number): Promise<PublicKey> {
  const mint = Keypair.generate()
  must(await chain.send(admin, [
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey,
      lamports: await chain.rentExempt(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, decimals, admin.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ], [mint]), 'create Token-2022 mint')
  return mint.publicKey
}

async function main() {
  const [scenariosPath, smallPath] = process.argv.slice(2)
  const scenarios: Scenario[] = JSON.parse(readFileSync(scenariosPath, 'utf8'))
  const small: Scenario = JSON.parse(readFileSync(smallPath, 'utf8'))[0]
  // smallest threshold above the cap, to probe the boundary as tightly as the scenario set allows
  const justAbove = scenarios
    .filter((s) => BigInt(s.migration_quote_threshold) > MAX_THRESHOLD)
    .sort((a, b) => Number(BigInt(a.migration_quote_threshold) - BigInt(b.migration_quote_threshold)))[0]

  const chain = liteSvmChain(zpvpPrograms())
  const admin = Keypair.generate()
  await chain.fund(admin.publicKey, 10n ** 16n)
  const tryMarket = async (scenario: Scenario, wsol: boolean) => {
    const f = await createMarketFixture(chain, admin, scenario, { wsol, traderCount: 0, traderLamports: 0n, skipMarket: true })
    return chain.send(admin, [f.initMarketIx()])
  }

  const sol = (s: Scenario) => `${Number(s.migration_quote_threshold) / 1e9} SOL`
  result(await tryMarket(small, false), `custom quote mint (threshold ${sol(small)}) rejected`, /code: 6017/)
  result(await tryMarket(justAbove, true), `wSOL, threshold ${sol(justAbove)} > 10 SOL rejected`, /code: 6018/)
  result(await tryMarket(small, true), `wSOL, threshold ${sol(small)} accepted`, null)

  // xStock quotes: allowlisted, each with its own threshold cap; probed exactly at the cap and one raw unit above
  const tryQuote = async (threshold: bigint, quote: QuoteOptions) => {
    const scenario = { ...small, migration_quote_threshold: threshold.toString() }
    const f = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: 0, traderLamports: 0n, skipMarket: true, quote })
    return chain.send(admin, [f.initMarketIx()])
  }
  const thresholdTooHigh = anchorError(6018, 'ThresholdTooHigh')
  for (const [name, cap] of XSTOCK_CAPS) {
    const quote = loadXStockQuote(chain, name)
    result(await tryQuote(cap, quote), `${name} threshold ${cap} accepted`, null)
    result(await tryQuote(cap + 1n, quote), `${name} threshold ${cap + 1n} rejected 6018`, thresholdTooHigh)
  }
  const fresh = await createToken2022Mint(chain, admin, XSTOCK_DECIMALS)
  result(await tryQuote(XSTOCK_CAPS[0][1], { mint: fresh, tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: XSTOCK_DECIMALS }),
    'fresh non-allowlisted Token-2022 mint rejected 6017', anchorError(6017, 'QuoteMintNotAllowed'))
}

main().catch((e) => { console.error(e); process.exit(1) })
