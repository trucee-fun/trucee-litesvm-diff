/**
 * Runs the real mainnet DBC program (dumped .so) inside LiteSVM.
 *
 * For each scenario (curve config exported by sim/export_configs.py):
 *   1. create_config + initialize_virtual_pool_with_token2022
 *   2. a random sequence of buys (PartialFill) and sells (ExactIn) from several traders
 *   3. after every swap, record trader balance deltas and pool state
 *
 * Output is replayed by sim/replay_diff.py against the Python port.
 *
 * Usage: npx tsx src/harness.ts SCENARIOS.json OUT.json [opsPerScenario]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import BN from 'bn.js'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { FailedTransactionMetadata, LiteSVM } from 'litesvm'
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  createDbcProgram,
  deriveDbcEventAuthority,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

const DBC_SO_PATH = process.env.DBC_SO ?? 'programs/dbc.so'
const QUOTE_DECIMALS = 9
const TRADER_COUNT = 5
const TRADER_QUOTE_BALANCE = 10_000n * 10n ** 9n
const SWAP_MODE_EXACT_IN = 0
const SWAP_MODE_PARTIAL_FILL = 1

type Scenario = {
  seed: number
  sqrt_start_price: string
  fee_numerator: number
  migration_quote_threshold: string
  curve: { sqrt_price: string; liquidity: string }[]
}

type OpRecord = {
  kind: 'buy' | 'sell'
  trader: number
  amount: string
  ok: boolean
  error?: string
  quote_delta?: string // trader quote balance change (signed)
  base_delta?: string // trader base balance change (signed)
  sqrt_price?: string
  quote_reserve?: string
}

// deterministic PRNG so runs are reproducible
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const { program } = createDbcProgram(new Connection('http://127.0.0.1:1'))

function send(svm: LiteSVM, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new Transaction().add(...ixs)
  tx.recentBlockhash = svm.latestBlockhash()
  tx.feePayer = payer.publicKey
  tx.sign(payer, ...signers)
  const result = svm.sendTransaction(tx)
  svm.expireBlockhash()
  if (result instanceof FailedTransactionMetadata) {
    const logs = result.meta().logs().slice(-4).join(' | ')
    return { ok: false as const, error: `${result.err().toString()} :: ${logs}` }
  }
  return { ok: true as const }
}

function tokenBalance(svm: LiteSVM, address: PublicKey): bigint {
  const account = svm.getAccount(address)
  if (!account) return 0n
  return Buffer.from(account.data).readBigUInt64LE(64)
}

function configParameters(s: Scenario) {
  const zeroVesting = {
    vestingPercentage: 0, bpsPerPeriod: 0, numberOfPeriods: 0,
    cliffDurationFromMigrationTime: 0, frequency: 0,
  }
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: new BN(s.fee_numerator),
        firstFactor: 0, secondFactor: new BN(0), thirdFactor: new BN(0), baseFeeMode: 0,
      },
      dynamicFee: null,
    },
    collectFeeMode: 0, // QuoteToken
    migrationOption: 1, // DAMM v2
    activationType: 0,
    tokenType: 1, // Token-2022
    tokenDecimal: 6,
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 100,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
    migrationQuoteThreshold: new BN(s.migration_quote_threshold),
    sqrtStartPrice: new BN(s.sqrt_start_price),
    lockedVesting: {
      amountPerPeriod: new BN(0), cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0), numberOfPeriod: new BN(0), cliffUnlockAmount: new BN(0),
    },
    migrationFeeOption: 0,
    tokenSupply: null,
    creatorTradingFeePercentage: 0,
    tokenUpdateAuthority: 1,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 },
    poolCreationFee: new BN(0),
    partnerLiquidityVestingInfo: zeroVesting,
    creatorLiquidityVestingInfo: zeroVesting,
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams: {
      numberOfPeriod: 0, sqrtPriceStepBps: 0, schedulerExpirationDuration: 0, reductionFactor: new BN(0),
    },
    enableFirstSwapWithMinFee: false,
    compoundingFeeBps: 0,
    padding: [0, 0],
    curve: s.curve.map((p) => ({ sqrtPrice: new BN(p.sqrt_price), liquidity: new BN(p.liquidity) })),
  }
}

async function runScenario(s: Scenario, opsPerScenario: number) {
  const svm = new LiteSVM().withLamports(10n ** 18n)
  svm.addProgramFromFile(DYNAMIC_BONDING_CURVE_PROGRAM_ID, DBC_SO_PATH)
  const payer = Keypair.generate()
  svm.airdrop(payer.publicKey, 1_000_000n * 10n ** 9n)

  // quote mint (plain SPL, 9 decimals)
  const quoteMint = Keypair.generate()
  const rent = svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))
  send(svm, payer, [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: quoteMint.publicKey,
      lamports: Number(rent), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(quoteMint.publicKey, QUOTE_DECIMALS, payer.publicKey, null),
  ], [quoteMint])

  const eventAuthority = deriveDbcEventAuthority()
  const config = Keypair.generate()
  const createConfigIx = await program.methods
    .createConfig(configParameters(s) as never)
    .accountsPartial({
      config: config.publicKey, feeClaimer: payer.publicKey, leftoverReceiver: payer.publicKey,
      quoteMint: quoteMint.publicKey, payer: payer.publicKey, eventAuthority,
    })
    .instruction()
  const created = send(svm, payer, [createConfigIx], [config])
  if (!created.ok) return { seed: s.seed, setup_error: `create_config: ${created.error}` }

  const baseMint = Keypair.generate()
  const pool = deriveDbcPoolAddress(quoteMint.publicKey, baseMint.publicKey, config.publicKey)
  const baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey)
  const quoteVault = deriveDbcTokenVaultAddress(pool, quoteMint.publicKey)
  const initIx = await program.methods
    .initializeVirtualPoolWithToken2022({ name: 'ZeroPvP', symbol: 'ZPVP', uri: 'https://x.y' })
    .accountsPartial({
      config: config.publicKey, poolAuthority: deriveDbcPoolAuthority(), creator: payer.publicKey,
      baseMint: baseMint.publicKey, quoteMint: quoteMint.publicKey, pool, baseVault, quoteVault,
      payer: payer.publicKey, tokenQuoteProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_2022_PROGRAM_ID,
      eventAuthority,
    })
    .instruction()
  const initialized = send(svm, payer, [initIx], [baseMint])
  if (!initialized.ok) return { seed: s.seed, setup_error: `init_pool: ${initialized.error}` }

  const traders = Array.from({ length: TRADER_COUNT }, () => Keypair.generate())
  const accounts = traders.map((t) => ({
    quote: getAssociatedTokenAddressSync(quoteMint.publicKey, t.publicKey, false, TOKEN_PROGRAM_ID),
    base: getAssociatedTokenAddressSync(baseMint.publicKey, t.publicKey, false, TOKEN_2022_PROGRAM_ID),
  }))
  for (const [i, t] of traders.entries()) {
    svm.airdrop(t.publicKey, 10n * 10n ** 9n)
    send(svm, payer, [
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, accounts[i].quote, t.publicKey, quoteMint.publicKey, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, accounts[i].base, t.publicKey, baseMint.publicKey, TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(quoteMint.publicKey, accounts[i].quote, payer.publicKey, TRADER_QUOTE_BALANCE),
    ])
  }

  const readPool = () =>
    program.coder.accounts.decode('virtualPool', Buffer.from(svm.getAccount(pool)!.data)).poolState
  const onchainConfig = program.coder.accounts.decode('poolConfig', Buffer.from(svm.getAccount(config.publicKey)!.data))
  const curvePoints = onchainConfig.curve as { sqrtPrice: BN; liquidity: BN }[]

  const rand = mulberry32(s.seed * 7919 + 1)
  const ops: OpRecord[] = []
  for (let n = 0; n < opsPerScenario; n++) {
    const trader = Math.floor(rand() * TRADER_COUNT)
    const held = tokenBalance(svm, accounts[trader].base)
    const isSell = held > 0n && rand() < 0.4
    let amount: bigint
    if (isSell) {
      const fraction = rand() < 0.5 ? 1 : rand()
      amount = BigInt(Math.max(1, Math.floor(Number(held) * fraction)))
      if (amount > held) amount = held
    } else {
      amount = BigInt(Math.floor(10 ** (rand() * 4.7 - 3) * 1e9)) // 0.001 .. 50 quote
    }
    const [input, output] = isSell
      ? [accounts[trader].base, accounts[trader].quote]
      : [accounts[trader].quote, accounts[trader].base]
    const swapIx = await program.methods
      .swap2({
        amount0: new BN(amount.toString()), amount1: new BN(0),
        swapMode: isSell ? SWAP_MODE_EXACT_IN : SWAP_MODE_PARTIAL_FILL,
      })
      .accountsPartial({
        poolAuthority: deriveDbcPoolAuthority(), config: config.publicKey, pool,
        inputTokenAccount: input, outputTokenAccount: output, baseVault, quoteVault,
        baseMint: baseMint.publicKey, quoteMint: quoteMint.publicKey, payer: traders[trader].publicKey,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null, eventAuthority,
      })
      .instruction()

    const before = { q: tokenBalance(svm, accounts[trader].quote), b: tokenBalance(svm, accounts[trader].base) }
    const result = send(svm, traders[trader], [swapIx])
    const record: OpRecord = { kind: isSell ? 'sell' : 'buy', trader, amount: amount.toString(), ok: result.ok }
    if (!result.ok) {
      record.error = result.error
    } else {
      const state = readPool()
      record.quote_delta = (tokenBalance(svm, accounts[trader].quote) - before.q).toString()
      record.base_delta = (tokenBalance(svm, accounts[trader].base) - before.b).toString()
      record.sqrt_price = state.sqrtPrice.toString()
      record.quote_reserve = state.quoteReserve.toString()
    }
    ops.push(record)
  }

  return {
    seed: s.seed,
    onchain: {
      sqrt_start_price: onchainConfig.sqrtStartPrice.toString(),
      migration_sqrt_price: onchainConfig.migrationSqrtPrice.toString(),
      migration_quote_threshold: onchainConfig.migrationQuoteThreshold.toString(),
      cliff_fee_numerator: onchainConfig.poolFees.baseFee.cliffFeeNumerator.toString(),
      curve: curvePoints
        .filter((p) => !p.liquidity.isZero())
        .map((p) => ({ sqrt_price: p.sqrtPrice.toString(), liquidity: p.liquidity.toString() })),
    },
    ops,
  }
}

async function main() {
  const [scenarioPath, outPath, opsArg] = process.argv.slice(2)
  if (!scenarioPath || !outPath) throw new Error('usage: harness.ts SCENARIOS.json OUT.json [ops]')
  const scenarios: Scenario[] = JSON.parse(readFileSync(scenarioPath, 'utf8'))
  const opsPerScenario = Number(opsArg ?? 120)
  const results = []
  for (const s of scenarios) {
    const r = await runScenario(s, opsPerScenario)
    const okOps = 'ops' in r ? r.ops!.filter((o) => o.ok).length : 0
    console.log(`seed ${s.seed}: ${'setup_error' in r ? r.setup_error : `${okOps} ok swaps`}`)
    results.push(r)
  }
  writeFileSync(outPath, JSON.stringify(results, null, 1))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
