/**
 * Minimal execution backend so the same Zero-PvP scenario runs on LiteSVM or a live cluster.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  Connection, Keypair, PublicKey, SendTransactionError, SystemProgram, Transaction, TransactionInstruction,
} from '@solana/web3.js'
import { FailedTransactionMetadata, LiteSVM } from 'litesvm'

export type TxResult = { ok: true; cu: bigint; signature?: string } | { ok: false; error: string }

export interface Chain {
  readonly name: string
  send(payer: Keypair, ixs: TransactionInstruction[], signers?: Keypair[]): Promise<TxResult>
  accountData(address: PublicKey): Promise<Buffer | null>
  rentExempt(space: number): Promise<number>
  lamports(address: PublicKey): Promise<bigint>
  /** Funds a fresh keypair from the chain's funding source. */
  fund(to: PublicKey, lamports: bigint): Promise<void>
}

const ERROR_LINE = /Error|failed|AnchorError/

export function liteSvmChain(programs: [PublicKey, string][]): Chain {
  const svm = new LiteSVM().withLamports(10n ** 18n).withNativeMints()
  for (const [id, path] of programs) svm.addProgramFromFile(id, path)
  return {
    name: 'litesvm',
    async send(payer, ixs, signers = []) {
      const tx = new Transaction().add(...ixs)
      tx.recentBlockhash = svm.latestBlockhash()
      tx.feePayer = payer.publicKey
      tx.sign(payer, ...signers)
      const res = svm.sendTransaction(tx)
      svm.expireBlockhash()
      if (res instanceof FailedTransactionMetadata) {
        const logs = res.meta().logs().filter((l) => ERROR_LINE.test(l)).slice(-3).join(' | ')
        return { ok: false, error: `${res.err().toString()} :: ${logs}` }
      }
      return { ok: true, cu: res.computeUnitsConsumed() }
    },
    async accountData(address) {
      const acc = svm.getAccount(address)
      return acc ? Buffer.from(acc.data) : null
    },
    async rentExempt(space) {
      return Number(svm.minimumBalanceForRentExemption(BigInt(space)))
    },
    async lamports(address) {
      return svm.getBalance(address) ?? 0n
    },
    async fund(to, lamports) {
      svm.airdrop(to, lamports)
    },
  }
}

export function loadKeypair(path = `${homedir()}/.config/solana/id.json`): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}

export function rpcChain(url: string, funder: Keypair): Chain {
  const connection = new Connection(url, 'confirmed')
  return {
    name: url,
    async send(payer, ixs, signers = []) {
      const tx = new Transaction().add(...ixs)
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
      tx.recentBlockhash = blockhash
      tx.feePayer = payer.publicKey
      tx.sign(payer, ...signers)
      try {
        const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
        const meta = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
        if (meta?.meta?.err) return { ok: false, error: `${JSON.stringify(meta.meta.err)} :: ${signature}` }
        return { ok: true, cu: BigInt(meta?.meta?.computeUnitsConsumed ?? 0), signature }
      } catch (err: unknown) {
        const logs = err instanceof SendTransactionError ? (err.logs ?? []).filter((l) => ERROR_LINE.test(l)).slice(-3).join(' | ') : ''
        return { ok: false, error: `${err instanceof Error ? err.message.split('\n')[0] : String(err)} :: ${logs}` }
      }
    },
    async accountData(address) {
      const acc = await connection.getAccountInfo(address, 'confirmed')
      return acc ? Buffer.from(acc.data) : null
    },
    async rentExempt(space) {
      return connection.getMinimumBalanceForRentExemption(space)
    },
    async lamports(address) {
      return BigInt(await connection.getBalance(address, 'confirmed'))
    },
    async fund(to, lamports) {
      const ix = SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports })
      const res = await this.send(funder, [ix])
      if (!res.ok) throw new Error(`funding ${to.toBase58()} failed: ${res.error}`)
    },
  }
}
