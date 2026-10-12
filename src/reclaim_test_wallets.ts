/**
 * Returns devnet SOL from the throwaway e2e trader wallets these scripts generate themselves to the payer.
 * The wallet keys are stored in gitignored *.traders.json files. Closes their wSOL ATAs and returns their lamports.
 * Safe to rerun; skips empty wallets.
 *
 * Usage: npx tsx src/reclaim_test_wallets.ts OUT.json.traders.json [--rpc env]
 * `--rpc env` reads the URL from DEVNET_RPC (exit 2 when unset); without `--rpc` it uses the public devnet RPC.
 * Refuses every endpoint whose genesis hash is not devnet's, before reading any wallet keys.
 */
import { readFileSync } from 'node:fs'
import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PUBLIC_DEVNET_RPC, UsageError, errorLine, loadKeypair, runRpcScript } from './chain'

const FEE = 5_000
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

async function main(rpcArg: string | undefined) {
  const tradersPath = process.argv[2]
  if (!tradersPath || tradersPath.startsWith('--')) throw new UsageError('usage: reclaim_test_wallets.ts OUT.json.traders.json [--rpc env]')
  const rpc = rpcArg ?? PUBLIC_DEVNET_RPC
  const connection = new Connection(rpc, 'confirmed')
  if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) {
    throw new Error('reclaim_test_wallets: RPC must return the devnet genesis hash; refusing to load wallets or send')
  }
  const funder = loadKeypair()
  const traders = (JSON.parse(readFileSync(tradersPath, 'utf8')) as number[][]).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)))
  let total = 0
  for (const t of traders) {
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, t.publicKey, false, TOKEN_PROGRAM_ID)
    const tx = new Transaction()
    if (await connection.getAccountInfo(wsolAta)) tx.add(createCloseAccountInstruction(wsolAta, t.publicKey, t.publicKey))
    const lamports = (await connection.getBalance(t.publicKey)) + ((await connection.getBalance(wsolAta)) || 0) - FEE
    if (lamports <= 0) continue
    tx.add(SystemProgram.transfer({ fromPubkey: t.publicKey, toPubkey: funder.publicKey, lamports }))
    try {
      await sendAndConfirmTransaction(connection, tx, [t])
      total += lamports
      console.log(`returned ${lamports / 1e9} SOL from test wallet ${t.publicKey.toBase58()}`)
    } catch (err) {
      console.log(`FAILED ${t.publicKey.toBase58()}: ${errorLine(err, rpc)}`)
      process.exitCode = 1
    }
  }
  console.log(`total returned to payer: ${total / 1e9} SOL`)
}

runRpcScript(main)
