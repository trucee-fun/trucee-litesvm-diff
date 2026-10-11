/**
 * Migrates a completed Zero-PvP DBC pool to DAMM v2 on a live cluster using the official SDK,
 * then reports the resulting DAMM v2 pool state.
 *
 * Usage: npx tsx src/migrate_devnet.ts E2E_RESULT.json [--rpc env|URL]
 * `--rpc env` reads the URL from DEVNET_RPC (exit 2 when unset); without `--rpc` it uses the public devnet RPC.
 */
import { readFileSync } from 'node:fs'
import { Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, createDbcProgram,
  deriveDammV2PoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { PUBLIC_DEVNET_RPC, UsageError, errorLine, loadKeypair, runRpcScript } from './chain'

async function main(rpcArg: string | undefined) {
  const e2ePath = process.argv[2]
  if (!e2ePath || e2ePath.startsWith('--')) throw new UsageError('usage: migrate_devnet.ts E2E_RESULT.json [--rpc env|URL]')
  const rpc = rpcArg ?? PUBLIC_DEVNET_RPC
  const e2e = JSON.parse(readFileSync(e2ePath, 'utf8'))
  const pool = new PublicKey(e2e.accounts.pool)
  const baseMint = new PublicKey(e2e.accounts.base_mint)
  const quoteMint = new PublicKey(e2e.accounts.quote_mint)
  const payer = loadKeypair()
  const connection = new Connection(rpc, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  const { program } = createDbcProgram(connection)
  // the DAMM v2 config must match the DBC config's migration fee option (6 = Customizable)
  const dbcConfig = await program.account.configWithTransferHook.fetch(new PublicKey(e2e.accounts.config))
  const migrationFeeOption: number = dbcConfig.config.migrationFeeOption
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption]
  console.log(`migration fee option ${migrationFeeOption} -> DAMM v2 config ${dammConfig.toBase58()}`)
  const before = await program.account.transferHookPool.fetch(pool).catch(() => null)
  console.log(`DBC pool ${pool.toBase58()}  migrationProgress(before)=${JSON.stringify(before?.poolState?.migrationProgress ?? before)}`)

  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({
    payer: payer.publicKey, pool, dammConfig,
  })
  const signers = [payer, firstPositionNftKeypair, secondPositionNftKeypair]
    .filter((k) => transaction.instructions.some((ix) => ix.keys.some((m) => m.isSigner && m.pubkey.equals(k.publicKey))))
  try {
    const sig = await sendAndConfirmTransaction(connection, transaction, signers, { commitment: 'confirmed' })
    console.log(`MIGRATION OK  signature=${sig}`)
  } catch (err: unknown) {
    const logs = (err as { logs?: string[] }).logs ?? (err as { transactionLogs?: string[] }).transactionLogs ?? []
    console.log(`MIGRATION FAILED: ${errorLine(err, rpc)}`)
    for (const l of logs.slice(-15)) console.log(`  ${l}`)
    process.exitCode = 1
    return
  }

  const dammPool = deriveDammV2PoolAddress(dammConfig, baseMint, quoteMint)
  const info = await connection.getAccountInfo(dammPool, 'confirmed')
  console.log(`DAMM v2 pool ${dammPool.toBase58()}  exists=${!!info}  owner=${info?.owner.toBase58()}`)
  const after = await program.account.transferHookPool.fetch(pool)
  console.log(`DBC migrationProgress(after)=${JSON.stringify(after.poolState.migrationProgress)} isMigrated=${after.poolState.isMigrated}`)
}

runRpcScript(main)
