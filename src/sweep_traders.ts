/**
 * Recovers SOL from the throwaway trader wallets of a live e2e run (closes wSOL ATAs, sends lamports to the funder).
 * Safe to rerun; skips empty wallets.
 *
 * Usage: npx tsx src/sweep_traders.ts OUT.json.traders.json [--rpc URL]
 */
import { readFileSync } from 'node:fs'
import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { loadKeypair } from './chain'

const FEE = 5_000

async function main() {
  const args = process.argv.slice(2)
  const rpc = args.includes('--rpc') ? args[args.indexOf('--rpc') + 1] : 'https://api.devnet.solana.com'
  const connection = new Connection(rpc, 'confirmed')
  const funder = loadKeypair()
  const traders = (JSON.parse(readFileSync(args[0], 'utf8')) as number[][]).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)))
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
      console.log(`swept ${lamports / 1e9} SOL from ${t.publicKey.toBase58()}`)
    } catch (err) {
      console.log(`FAILED ${t.publicKey.toBase58()}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      process.exitCode = 1
    }
  }
  console.log(`total swept: ${total / 1e9} SOL`)
}

main().catch((e) => { console.error(e); process.exit(1) })
