/**
 * Measures the fee a seller actually pays on a migrated DAMM v2 pool, via the SDK quote (same math as
 * the program), then pushes the price up with a real buy and measures again.
 *
 * Usage: npx tsx src/damm_fee_probe.ts DAMM_POOL [--push-quote LAMPORTS] [--rpc env]
 * `--rpc env` reads DEVNET_RPC without exposing the URL in argv or output; defaults to the public devnet RPC.
 */
import BN from 'bn.js'
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { getMint } from '@solana/spl-token'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { PUBLIC_DEVNET_RPC, UsageError, loadKeypair, runRpcScript } from './chain'

const DUMP_SHARE_OF_BASE_RESERVE = 20 // sell 1/20 = 5% of the pool's base reserve

async function main(rpcArg: string | undefined) {
  const args = process.argv.slice(2)
  const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
  if (!args[0] || args[0].startsWith('--')) {
    throw new UsageError('usage: damm_fee_probe.ts DAMM_POOL [--push-quote LAMPORTS] [--rpc env]')
  }
  const rpc = rpcArg ?? PUBLIC_DEVNET_RPC
  const pool = new PublicKey(args[0])
  const pushQuote = flag('--push-quote')
  const connection = new Connection(rpc, 'confirmed')
  const cpAmm = new CpAmm(connection)
  const payer = loadKeypair()

  const probe = async (label: string) => {
    const state = await cpAmm.fetchPoolState(pool)
    const [mintA, mintB] = await Promise.all([state.tokenAMint, state.tokenBMint].map(async (m) => {
      const info = await connection.getAccountInfo(m)
      return getMint(connection, m, 'confirmed', info!.owner)
    }))
    const reserveA = new BN((await connection.getTokenAccountBalance(state.tokenAVault)).value.amount)
    const slot = await connection.getSlot()
    const time = (await connection.getBlockTime(slot))!
    const quote = cpAmm.getQuote({
      inAmount: reserveA.divn(DUMP_SHARE_OF_BASE_RESERVE), inputTokenMint: state.tokenAMint, slippage: 1, poolState: state,
      currentTime: time, currentSlot: slot, tokenADecimal: mintA.decimals, tokenBDecimal: mintB.decimals,
    })
    const fee = Number(quote.totalFee.toString())
    const gross = fee + Number(quote.swapOutAmount.toString())
    console.log(`${label.padEnd(34)} sell 5% of base reserve -> fee ${(100 * fee / gross).toFixed(3)}% of proceeds`)
    return state
  }

  const state = await probe('before push (current price)')
  if (pushQuote) {
    const tx: Transaction = await cpAmm.swap({
      payer: payer.publicKey, pool, inputTokenMint: state.tokenBMint, outputTokenMint: state.tokenAMint,
      amountIn: new BN(pushQuote), minimumAmountOut: new BN(0), tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint,
      tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
      tokenAProgram: (await connection.getAccountInfo(state.tokenAMint))!.owner,
      tokenBProgram: (await connection.getAccountInfo(state.tokenBMint))!.owner, referralTokenAccount: null,
    })
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' })
    const after = await cpAmm.fetchPoolState(pool)
    const rise = (Number(after.sqrtPrice.toString()) / Number(state.sqrtPrice.toString())) ** 2 - 1
    console.log(`pushed price up ${(100 * rise).toFixed(1)}% with a ${pushQuote}-lamport buy  sig=${sig}`)
    await probe('after price rise')
  }
}

runRpcScript(main)
