/**
 * Mainnet-beta launch caps, run against the default (capped) router build: only allowlisted quote mints, each with a
 * graduation threshold cap (wSOL 10 SOL, TSLAx 5 shares, NVDAx 10 shares), each probed exactly at the cap and one raw
 * unit above. xStocks are mainnet Token-2022 snapshots.
 *
 * Usage: ROUTER_SO=programs/router_capped.so npx tsx src/zpvp_caps.ts SCENARIOS.json SMALL_SCENARIO.json
 */
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { MINT_SIZE, TOKEN_2022_PROGRAM_ID, createInitializeMint2Instruction } from '@solana/spl-token'
import { Chain, TxResult, liteSvmChain } from './chain'
import {
  CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET, QuoteOptions, Scenario, XStock, anchorError, check, createMarketFixture, loadXStockQuote, must,
} from './fixture'
import { zpvpPrograms } from './zpvp_e2e'

/** zpvp_router QUOTE_CAPS for wSOL (lamports): 10 SOL. */
const WSOL_CAP = 10_000_000_000n
/** zpvp_router QUOTE_CAPS for the xStocks (raw units, 8 decimals). */
const XSTOCK_CAPS: [XStock, bigint][] = [['TSLAx', 500_000_000n], ['NVDAx', 1_000_000_000n]]
const XSTOCK_DECIMALS = 8
const QUOTE_MINT_NOT_ALLOWED = anchorError(6017, 'QuoteMintNotAllowed')
const THRESHOLD_TOO_HIGH = anchorError(6018, 'ThresholdTooHigh')

function result(r: TxResult, label: string, expected: RegExp | null): void {
  const ok = expected === null ? r.ok : !r.ok && expected.test(r.error)
  check(ok, label, r.ok ? 'accepted' : r.error.replace(/\s+/g, ' ').slice(0, 100))
}

const thresholdOf = (s: Scenario) => BigInt(s.migration_quote_threshold)
const withThreshold = (s: Scenario, threshold: bigint): Scenario => ({ ...s, migration_quote_threshold: threshold.toString() })

/** The scenario with the smallest threshold above `cap`: its curve is built for a threshold near the cap. */
function smallestAbove(scenarios: Scenario[], cap: bigint, path: string): Scenario {
  const above = scenarios.filter((s) => thresholdOf(s) > cap)
  if (above.length === 0) throw new Error(`${path}: no scenario with a threshold above ${cap}, cannot probe the wSOL cap`)
  return above.reduce((min, s) => (thresholdOf(s) < thresholdOf(min) ? s : min))
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
  if (!scenariosPath || !smallPath) throw new Error('usage: zpvp_caps.ts SCENARIOS.json SMALL_SCENARIO.json')
  const scenarios: Scenario[] = JSON.parse(readFileSync(scenariosPath, 'utf8'))
  const small: Scenario | undefined = JSON.parse(readFileSync(smallPath, 'utf8'))[0]
  if (!small) throw new Error(`${smallPath}: no scenario at index 0`)
  const justAbove = smallestAbove(scenarios, WSOL_CAP, scenariosPath)

  const chain = liteSvmChain(zpvpPrograms())
  const admin = Keypair.generate()
  await chain.fund(admin.publicKey, 10n ** 16n)
  const tryMarket = async (scenario: Scenario, wsol: boolean) => {
    const f = await createMarketFixture(chain, admin, scenario, { wsol, traderCount: 0, traderLamports: 0n, skipMarket: true })
    return chain.send(admin, [f.initMarketIx()])
  }

  const sol = (s: Scenario) => `${Number(s.migration_quote_threshold) / 1e9} SOL`
  result(await tryMarket(small, false), `custom quote mint (threshold ${sol(small)}) rejected 6017`, QUOTE_MINT_NOT_ALLOWED)
  result(await tryMarket(justAbove, true), `wSOL, threshold ${sol(justAbove)} > 10 SOL rejected 6018`, THRESHOLD_TOO_HIGH)

  // Exact wSOL boundary. The router's cap check (init_market) reads only the DBC config's quote_mint and
  // migration_quote_threshold, so the curve matters only in that DBC must accept the config. No scenario is built for
  // exactly 10 SOL; the smallest one above the cap is built for a slightly higher threshold, and lowering its threshold
  // to 10 SOL only moves the migration point down that same curve. DBC accepts both configs (createMarketFixture's
  // create_config step aborts the run otherwise) and the threshold DBC stored is read back, so the two probes differ
  // in nothing but one lamport of threshold.
  const tryWsolAt = async (threshold: bigint) => {
    const f = await createMarketFixture(chain, admin, withThreshold(justAbove, threshold),
      { wsol: true, traderCount: 0, traderLamports: 0n, skipMarket: true })
    const stored = (await chain.accountData(f.config.publicKey))?.readBigUInt64LE(CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET)
    if (stored !== threshold) throw new Error(`DBC config stores migration_quote_threshold ${stored}, expected ${threshold}`)
    return chain.send(admin, [f.initMarketIx()])
  }
  result(await tryWsolAt(WSOL_CAP), `wSOL threshold ${WSOL_CAP} (exactly 10 SOL, as stored by DBC) accepted`, null)
  result(await tryWsolAt(WSOL_CAP + 1n), `wSOL threshold ${WSOL_CAP + 1n} (as stored by DBC) rejected 6018`, THRESHOLD_TOO_HIGH)
  result(await tryMarket(small, true), `wSOL, threshold ${sol(small)} accepted`, null)

  // xStock quotes: allowlisted, each with its own threshold cap; probed exactly at the cap and one raw unit above
  const tryQuote = async (threshold: bigint, quote: QuoteOptions) => {
    const f = await createMarketFixture(chain, admin, withThreshold(small, threshold),
      { wsol: false, traderCount: 0, traderLamports: 0n, skipMarket: true, quote })
    return chain.send(admin, [f.initMarketIx()])
  }
  for (const [name, cap] of XSTOCK_CAPS) {
    const quote = loadXStockQuote(chain, name)
    result(await tryQuote(cap, quote), `${name} threshold ${cap} accepted`, null)
    result(await tryQuote(cap + 1n, quote), `${name} threshold ${cap + 1n} rejected 6018`, THRESHOLD_TOO_HIGH)
  }
  const fresh = await createToken2022Mint(chain, admin, XSTOCK_DECIMALS)
  result(await tryQuote(XSTOCK_CAPS[0][1], { mint: fresh, tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: XSTOCK_DECIMALS }),
    'fresh non-allowlisted Token-2022 mint rejected 6017', QUOTE_MINT_NOT_ALLOWED)
}

main().catch((e) => { console.error(e); process.exit(1) })
