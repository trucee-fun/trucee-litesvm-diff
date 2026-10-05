/**
 * Mainnet-beta launch caps, run against the default (capped) router build:
 * only wSOL-quoted markets, and a graduation threshold of at most 10 SOL.
 *
 * Usage: ROUTER_SO=programs/router_capped.so npx tsx src/zpvp_caps.ts SCENARIOS.json SMALL_SCENARIO.json
 */
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import { TxResult, liteSvmChain } from './chain'
import { Scenario, check, createMarketFixture } from './fixture'
import { zpvpPrograms } from './zpvp_e2e'

const MAX_THRESHOLD = 10_000_000_000n

function result(r: TxResult, label: string, expected: RegExp | null): void {
  const ok = expected === null ? r.ok : !r.ok && expected.test(r.error)
  check(ok, label, r.ok ? 'accepted' : r.error.replace(/\s+/g, ' ').slice(0, 100))
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
}

main().catch((e) => { console.error(e); process.exit(1) })
