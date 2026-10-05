/**
 * Proves the migrated Zero-PvP token trades on DAMM v2: buy then sell with a fresh wallet balance.
 *
 * Usage: npx tsx src/damm_swap_devnet.ts E2E_RESULT.json DAMM_POOL [--rpc URL]
 */
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js'
import { SystemProgram } from '@solana/web3.js'
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { loadKeypair } from './chain'

const BUY_QUOTE = new BN(1_000_000_000) // 1 quote token
const BUY_QUOTE_WSOL = new BN(50_000_000) // 0.05 SOL when the quote is real SOL

async function main() {
  const args = process.argv.slice(2)
  const rpc = args.includes('--rpc') ? args[args.indexOf('--rpc') + 1] : 'https://api.devnet.solana.com'
  const e2e = JSON.parse(readFileSync(args[0], 'utf8'))
  const pool = new PublicKey(args[1])
  const baseMint = new PublicKey(e2e.accounts.base_mint)
  const quoteMint = new PublicKey(e2e.accounts.quote_mint)
  const payer = loadKeypair()
  const connection = new Connection(rpc, 'confirmed')
  const cpAmm = new CpAmm(connection)
  const state = await cpAmm.fetchPoolState(pool)

  const quoteAta = getAssociatedTokenAddressSync(quoteMint, payer.publicKey, false, TOKEN_PROGRAM_ID)
  const baseAta = getAssociatedTokenAddressSync(baseMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID)
  // The DAMM SDK unwraps (closes) the wSOL account after a swap, so for SOL we measure ATA + wallet lamports.
  const tokenBalanceOrZero = async (a: PublicKey) => {
    const info = await connection.getAccountInfo(a, 'confirmed')
    return info ? new BN((await connection.getTokenAccountBalance(a, 'confirmed')).value.amount) : new BN(0)
  }
  const balance = async (a: PublicKey) => {
    const tokens = await tokenBalanceOrZero(a)
    return quoteMint.equals(NATIVE_MINT) && a.equals(quoteAta)
      ? tokens.add(new BN(await connection.getBalance(payer.publicKey, 'confirmed')))
      : tokens
  }
  const programFor = (mint: PublicKey) => (mint.equals(baseMint) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)

  const isWsol = quoteMint.equals(NATIVE_MINT)
  const buyQuote = isWsol ? BUY_QUOTE_WSOL : BUY_QUOTE
  const fundQuote = isWsol
    ? [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: quoteAta, lamports: BigInt(buyQuote.toString()) }), createSyncNativeInstruction(quoteAta)]
    : [createMintToInstruction(quoteMint, quoteAta, payer.publicKey, BigInt(buyQuote.toString()))]
  const setup = await connection.getLatestBlockhash()
  const { Transaction } = await import('@solana/web3.js')
  const setupTx = new Transaction({ ...setup, feePayer: payer.publicKey }).add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, quoteAta, payer.publicKey, quoteMint, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, baseAta, payer.publicKey, baseMint, TOKEN_2022_PROGRAM_ID),
    ...fundQuote,
  )
  await sendAndConfirmTransaction(connection, setupTx, [payer], { commitment: 'confirmed' })

  const swap = async (inputMint: PublicKey, outputMint: PublicKey, amountIn: BN, label: string) => {
    const inAta = inputMint.equals(baseMint) ? baseAta : quoteAta
    const outAta = outputMint.equals(baseMint) ? baseAta : quoteAta
    const [inBefore, outBefore] = [await balance(inAta), await balance(outAta)]
    const tx = await cpAmm.swap({
      payer: payer.publicKey, pool, inputTokenMint: inputMint, outputTokenMint: outputMint,
      amountIn, minimumAmountOut: new BN(0),
      tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
      tokenAProgram: programFor(state.tokenAMint), tokenBProgram: programFor(state.tokenBMint), referralTokenAccount: null,
    })
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' })
      const [inAfter, outAfter] = [await balance(inAta), await balance(outAta)]
      const note = isWsol ? ' (SOL side includes ~tx fee)' : ''
      console.log(`PASS  DAMM v2 ${label}: in=${inBefore.sub(inAfter)} out=${outAfter.sub(outBefore)}${note}  sig=${sig}`)
      return outAfter.sub(outBefore)
    } catch (err: unknown) {
      const logs = (err as { logs?: string[] }).logs ?? []
      console.log(`FAIL  DAMM v2 ${label}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      for (const l of logs.slice(-8)) console.log(`  ${l}`)
      process.exitCode = 1
      return new BN(0)
    }
  }

  const bought = await swap(quoteMint, baseMint, buyQuote, 'buy (quote -> base)')
  if (bought.gtn(0)) await swap(baseMint, quoteMint, bought.divn(2), 'sell (base -> quote)')
}

main().catch((e) => { console.error(e); process.exit(1) })
