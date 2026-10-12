/**
 * Negative tests: every substituted / malicious input must be rejected and must not move funds.
 * Two markets (A, B) share one quote mint so B's accounts can be smuggled into A's instructions.
 *
 * Usage: npx tsx src/zpvp_negative.ts SCENARIOS.json INDEX
 */
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { Keypair, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createApproveCheckedInstruction,
  createInitializeAccount3Instruction, getAccountLen,
} from '@solana/spl-token'
import { deriveDbcPoolAddress, deriveDbcTokenVaultAddress, getDynamicFeeParams } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { TxResult, liteSvmChain } from './chain'
import {
  BASE_DECIMALS, HOOK_ID, HOOK_REJECTION, ROUTER_ID, Scenario, check, configParameters, createMarketFixture, dbc,
  eventAuthority, must, poolAuthority,
} from './fixture'
import { GRADUATION_CHUNKS, spreadBuys, zpvpPrograms } from './zpvp_e2e'

/** Anti-Whale: a curve needs >= 5 positions to graduate; buys are spread so none passes the cap. */
const TRADERS = 6
const TRADER_LAMPORTS = 10n ** 15n
const PUMP_BUYS = Number(GRADUATION_CHUNKS / 4n) // the price pump spends threshold / 4 in spread chunks

function rejected(r: TxResult, label: string, mustMatch?: RegExp): void {
  const ok = !r.ok && (!mustMatch || mustMatch.test(r.error))
  check(ok, label, r.ok ? 'SUCCEEDED (vulnerable!)' : r.error.replace(/\s+/g, ' ').slice(0, 110))
}

async function main() {
  const [scenarioPath, indexArg] = process.argv.slice(2)
  const scenario: Scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))[Number(indexArg ?? 0)]
  const chain = liteSvmChain(zpvpPrograms())
  const admin = Keypair.generate()
  await chain.fund(admin.publicKey, 10n ** 16n)

  const A = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: TRADERS, traderLamports: TRADER_LAMPORTS })
  const B = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: 1, traderLamports: TRADER_LAMPORTS, quoteMint: A.quoteMintPk })
  const t = A.traders
  const send = (signer: number, ixs: TransactionInstruction[]) => chain.send(t[signer], ixs)
  const buy = 10n ** 9n

  // seed state: trader 0 and 1 hold positions in A, trader 0 of B holds a position in B
  must(await send(0, A.buyIxs(0, buy)), 'A buy 0')
  must(await send(1, A.buyIxs(1, buy)), 'A buy 1')
  must(await chain.send(B.traders[0], B.buyIxs(0, buy)), 'B buy 0')
  const bufferA = await A.balanceOf(A.buffer)
  const pos0 = await A.readPosition(0)

  console.log('-- account substitution')
  rejected(await send(0, A.buyIxs(0, buy, { market: B.market })), 'buy: market B with pool A accounts')
  rejected(await send(0, [A.sellIx(0, 1n, { buffer: B.buffer })]), 'sell: buffer of market B')
  rejected(await send(0, A.buyIxs(0, buy, { pool: B.pool, baseVault: B.baseVault, quoteVault: B.quoteVault, baseMint: B.baseMint.publicKey, config: B.config.publicKey })),
    'buy: market A with all of pool B accounts')
  rejected(await send(0, A.buyIxs(0, buy, { dbcProgram: HOOK_ID })), 'buy: fake DBC program id')
  rejected(await send(1, [A.sellIx(1, 1n, { position: A.positionOf(0) })]), "sell: someone else's position PDA")
  rejected(await send(0, A.buyIxs(0, buy, { userBase: A.ata[1].base })), "buy: output into someone else's token account")
  rejected(await send(0, A.buyIxs(0, buy, { hookAccounts: [] })), 'buy: missing hook accounts')

  console.log('-- amounts')
  rejected(await send(0, [A.sellIx(0, pos0.tokens + 1n)]), 'sell: more tokens than the position holds')
  rejected(await send(0, [A.sellIx(0, 0n)]), 'sell: zero tokens')

  console.log('-- market setup')
  rejected(await chain.send(admin, [A.initMarketIx()]), 'init_market: second market for the same pool')
  const fresh = await createMarketFixture(chain, admin, scenario, { wsol: false, traderCount: 0, traderLamports: 0n, quoteMint: A.quoteMintPk, skipMarket: true })
  rejected(await chain.send(admin, [fresh.initMarketIx({ config: A.config.publicKey })]), "init_market: pool with another pool's config")
  // a plain (non-hook) DBC pool must not get a market
  const plainConfig = Keypair.generate()
  must(await chain.send(admin, [await dbc.methods.createConfig(configParameters(scenario) as never).accountsPartial({
    config: plainConfig.publicKey, feeClaimer: admin.publicKey, leftoverReceiver: admin.publicKey, quoteMint: A.quoteMintPk,
    payer: admin.publicKey, eventAuthority }).instruction()], [plainConfig]), 'plain config')
  const plainBase = Keypair.generate()
  const plainPool = deriveDbcPoolAddress(A.quoteMintPk, plainBase.publicKey, plainConfig.publicKey)
  must(await chain.send(admin, [await dbc.methods.initializeVirtualPoolWithToken2022({ name: 'Plain', symbol: 'PLN', uri: 'https://x.y' })
    .accountsPartial({ config: plainConfig.publicKey, poolAuthority, creator: admin.publicKey, baseMint: plainBase.publicKey,
      quoteMint: A.quoteMintPk, pool: plainPool, baseVault: deriveDbcTokenVaultAddress(plainPool, plainBase.publicKey),
      quoteVault: deriveDbcTokenVaultAddress(plainPool, A.quoteMintPk), payer: admin.publicKey,
      tokenQuoteProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_2022_PROGRAM_ID, eventAuthority }).instruction()], [plainBase]), 'plain pool')
  rejected(await chain.send(admin, [A.initMarketIx({ pool: plainPool, config: plainConfig.publicKey })]), 'init_market: non-hook DBC pool')

  console.log('-- configs outside the supported static, quote-collected fee model')
  const marketFor = async (label: string, extra: Partial<Parameters<typeof createMarketFixture>[3]>, expected: RegExp) => {
    const f = await createMarketFixture(chain, admin, scenario, {
      wsol: false, traderCount: 0, traderLamports: 0n, quoteMint: A.quoteMintPk, skipMarket: true, ...extra })
    rejected(await chain.send(admin, [f.initMarketIx()]), label, expected)
  }
  // any executable program can be a DBC hook; the router itself stands in for a permissive fake hook
  await marketFor('init_market: pool whose hook is not zpvp_hook', { hookProgram: ROUTER_ID }, /code: 6013/)
  const baseFee = configParameters(scenario).poolFees.baseFee
  await marketFor('init_market: decaying fee scheduler', { configOverrides: { poolFees: {
    baseFee: { ...baseFee, cliffFeeNumerator: new BN(500_000_000), firstFactor: 10, secondFactor: new BN(60), thirdFactor: new BN(10_000_000) },
    dynamicFee: null } } }, /code: 6014/)
  await marketFor('init_market: dynamic (volatility) fee enabled', { configOverrides: { poolFees: {
    baseFee, dynamicFee: getDynamicFeeParams(Number(scenario.fee_numerator) / 100_000) } } }, /code: 6014/)
  await marketFor('init_market: fees collected in the base token', { configOverrides: { collectFeeMode: 1 } }, /code: 6014/)

  console.log('-- base token accounts must have immutable ownership')
  const looseAccount = Keypair.generate()
  const looseLen = getAccountLen([ExtensionType.TransferHookAccount])
  must(await chain.send(t[0], [
    SystemProgram.createAccount({ fromPubkey: t[0].publicKey, newAccountPubkey: looseAccount.publicKey,
      lamports: await chain.rentExempt(looseLen), space: looseLen, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeAccount3Instruction(looseAccount.publicKey, A.baseMint.publicKey, t[0].publicKey, TOKEN_2022_PROGRAM_ID),
  ], [looseAccount]), 'create non-ATA base account')
  rejected(await send(0, A.buyIxs(0, buy, { userBase: looseAccount.publicKey })), 'buy: base account without ImmutableOwner (non-ATA)')

  console.log('-- hook bypass attempts')
  rejected(await send(0, [...A.buyIxs(0, buy), A.transferIx(0, 2, 1n, true)]),
    'transfer as a second top-level ix next to a router buy', HOOK_REJECTION)
  must(await send(0, [createApproveCheckedInstruction(A.ata[0].base, A.baseMint.publicKey, t[2].publicKey, t[0].publicKey,
    10n ** 6n, BASE_DECIMALS, [], TOKEN_2022_PROGRAM_ID)]), 'approve delegate')
  rejected(await send(2, [A.transferIx(0, 2, 1n, true, t[2].publicKey)]), 'delegate transfer_checked', HOOK_REJECTION)
  rejected(await send(0, [A.transferIx(0, 1, 1n, false)]), 'transfer without hook accounts')

  console.log('-- lifecycle')
  rejected(await send(0, [A.claimIx(t[0].publicKey, 0)]), 'claim before finalize')
  rejected(await chain.send(admin, [A.finalizeIx()]), 'finalize before graduation')
  check((await A.balanceOf(A.buffer)) === bufferA, 'buffer A untouched by all rejected attempts', `${bufferA}`)

  const threshold = BigInt(scenario.migration_quote_threshold)
  // build a surplus: trader 2 buys, the price rises, trader 2 exits at cost and the gain stays in the buffer
  must(await send(2, A.buyIxs(2, buy)), 'A buy 2')
  const pumpers = t.map((_, i) => i).filter((i) => i !== 2)
  const pumpBuys = await spreadBuys(A, threshold, { who: pumpers, maxBuys: PUMP_BUYS })
  if (pumpBuys !== PUMP_BUYS) throw new Error(`A price pump: ${pumpBuys}/${PUMP_BUYS} buys before the curve completed`)
  must(await send(2, [A.sellIx(2, (await A.readPosition(2)).tokens)]), 'A trader 2 exits at cost')
  check((await A.balanceOf(A.buffer)) > 0n, 'buffer A holds a surplus', `${await A.balanceOf(A.buffer)}`)
  await spreadBuys(A, threshold)
  check(await A.curveDone(), 'curve A completed')
  rejected(await send(0, A.buyIxs(0, buy)), 'buy after graduation')
  rejected(await chain.send(admin, [A.finalizeIx({ buffer: B.buffer })]), 'finalize A with buffer B')
  must(await chain.send(admin, [A.finalizeIx()]), 'finalize A')
  rejected(await chain.send(admin, [A.finalizeIx()]), 'finalize twice')
  rejected(await send(0, [A.claimIx(t[0].publicKey, 0, { buffer: B.buffer })]), 'claim with buffer B')

  console.log('-- crank claims (anyone may claim, only the owner can receive)')
  const crank = t[1]
  const crankSend = (ix: TransactionInstruction) => chain.send(crank, [ix])
  rejected(await crankSend(A.claimIx(crank.publicKey, 0, { ownerQuote: A.ata[1].quote })), "crank: route owner's share into the crank's ATA")
  rejected(await crankSend(A.claimIx(crank.publicKey, 0, { owner: crank.publicKey })), "crank: name itself owner of someone else's position")
  rejected(await crankSend(A.claimIx(crank.publicKey, 0, { owner: crank.publicKey, ownerQuote: A.ata[1].quote })),
    "crank: owner + ATA both swapped to the crank")
  const looseQuote = Keypair.generate()
  must(await chain.send(t[0], [
    SystemProgram.createAccount({ fromPubkey: t[0].publicKey, newAccountPubkey: looseQuote.publicKey,
      lamports: await chain.rentExempt(165), space: 165, programId: TOKEN_PROGRAM_ID }),
    createInitializeAccount3Instruction(looseQuote.publicKey, A.quoteMintPk, t[0].publicKey, TOKEN_PROGRAM_ID),
  ], [looseQuote]), 'create non-ATA quote account for trader 0')
  rejected(await crankSend(A.claimIx(crank.publicKey, 0, { ownerQuote: looseQuote.publicKey })), "crank: owner's non-canonical quote account")
  rejected(await crankSend(A.claimIx(crank.publicKey, 0, { buffer: B.buffer })), 'crank: buffer of market B')
  const owner0Before = await A.balanceOf(A.ata[0].quote)
  const crank0Before = await A.balanceOf(A.ata[1].quote)
  must(await crankSend(A.claimIx(crank.publicKey, 0)), 'crank claims for trader 0')
  check((await A.balanceOf(A.ata[0].quote)) > owner0Before && (await A.balanceOf(A.ata[1].quote)) === crank0Before,
    "crank claim pays trader 0's ATA, crank's balance unchanged")
  rejected(await send(0, [A.claimIx(t[0].publicKey, 0)]), 'claim twice (owner after crank)')
  must(await send(1, [A.claimIx(t[1].publicKey, 1)]), 'trader 1 claims own position')
  void BN
}

main().catch((e) => { console.error(e); process.exit(1) })
