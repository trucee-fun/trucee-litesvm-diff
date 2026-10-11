/**
 * Minimal execution backend so the same Zero-PvP scenario runs on LiteSVM or a live cluster.
 *
 * A private RPC URL carries the provider's API key, so it is never printed: live scripts take `--rpc env` (the URL
 * comes from DEVNET_RPC, not argv), chains are named by `chainLabel`, and errors and console output pass through
 * `redactRpc`.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { format, inspect } from 'node:util'
import {
  Connection, Keypair, PublicKey, SendTransactionError, SystemProgram, Transaction, TransactionInstruction,
} from '@solana/web3.js'
import { Clock, FailedTransactionMetadata, LiteSVM } from 'litesvm'

export type TxResult = { ok: true; cu: bigint; signature?: string; logs?: string[] } | { ok: false; error: string }

/** Raw account contents for `Chain.setAccount`. */
export type RawAccount = { lamports: bigint; owner: PublicKey; executable: boolean; data: Buffer }

export interface Chain {
  readonly name: string
  send(payer: Keypair, ixs: TransactionInstruction[], signers?: Keypair[]): Promise<TxResult>
  accountData(address: PublicKey): Promise<Buffer | null>
  rentExempt(space: number): Promise<number>
  lamports(address: PublicKey): Promise<bigint>
  /** Funds a fresh keypair from the chain's funding source. */
  fund(to: PublicKey, lamports: bigint): Promise<void>
  /** Overwrites an account bypassing the runtime (LiteSVM only): loads mainnet fixtures, sets token balances. */
  setAccount?(address: PublicKey, account: RawAccount): void
  /** Warps the clock sysvar's unix_timestamp, leaving slot and epoch alone (LiteSVM only). */
  setClock?(unixTimestamp: bigint): void
}

const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n

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
      return { ok: true, cu: res.computeUnitsConsumed(), logs: res.logs() }
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
    setAccount(address, account) {
      if (account.lamports < 0n || account.lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`setAccount ${address.toBase58()}: lamports ${account.lamports} out of range`)
      }
      svm.setAccount(address, {
        lamports: Number(account.lamports), owner: account.owner, executable: account.executable, data: Uint8Array.from(account.data),
      })
    },
    setClock(unixTimestamp) {
      if (unixTimestamp < I64_MIN || unixTimestamp > I64_MAX) throw new Error(`setClock: unix timestamp ${unixTimestamp} is not an i64`)
      const c = svm.getClock()
      svm.setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unixTimestamp))
    },
  }
}

export function loadKeypair(path = `${homedir()}/.config/solana/id.json`): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}

/** Default for live scripts run without `--rpc`. Public and rate-limited; live e2e runs must not use it. */
export const PUBLIC_DEVNET_RPC = 'https://api.devnet.solana.com'
/** `--rpc env` reads the URL from this variable, so the URL never sits in argv where `ps` shows it. */
export const RPC_ENV_VAR = 'DEVNET_RPC'
const RPC_FROM_ENV = 'env'
const REDACTED = '[redacted]'
/** Path segments, query values and credentials shorter than this are not treated as secrets on their own. */
const MIN_SECRET_PART = 8
const EXIT_FAILURE = 1
const EXIT_USAGE = 2

/** A bad command line or missing environment: the script exits 2. */
export class UsageError extends Error {}

/** Cluster label for logs and output files. Never the RPC URL itself: a private URL carries an API key. */
export function chainLabel(rpc: string | undefined): 'litesvm' | 'devnet' | 'custom' {
  if (rpc === undefined) return 'litesvm'
  try {
    return new URL(rpc).hostname.includes('devnet') ? 'devnet' : 'custom'
  } catch {
    return 'custom'
  }
}

/**
 * The URL given by `--rpc`, or undefined when the flag is absent. The literal `env` reads DEVNET_RPC; anything else
 * is taken as the URL itself (local validators). Throws UsageError when the value or DEVNET_RPC is missing.
 */
export function rpcFromArgs(args: readonly string[]): string | undefined {
  const i = args.indexOf('--rpc')
  if (i < 0) return undefined
  const value = args[i + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`--rpc needs a value: ${RPC_FROM_ENV} (reads ${RPC_ENV_VAR}) or a local validator URL`)
  }
  if (value !== RPC_FROM_ENV) return value
  const url = process.env[RPC_ENV_VAR]
  if (!url) throw new UsageError(`${RPC_ENV_VAR} is not set`)
  return url
}

/** A string plus its encodeURIComponent and decodeURIComponent forms. */
function uriVariants(s: string): string[] {
  const variants = [s, encodeURIComponent(s)]
  try {
    variants.push(decodeURIComponent(s))
  } catch {
    // malformed % escape: the raw and encoded forms still cover it
  }
  return variants
}

/**
 * Everything in the URL that can carry the provider key, raw, URI-encoded and URI-decoded, longest first. The URL,
 * href and host always count. Path, query and credential pieces (including each path segment and each query value,
 * so a bare key is caught) count from MIN_SECRET_PART characters.
 */
function secretParts(url: string): string[] {
  const always = [url]
  const pieces: string[] = []
  try {
    const u = new URL(url)
    always.push(u.href, u.host, u.hostname)
    pieces.push(u.username, u.password, u.pathname, u.search, u.pathname + u.search,
      ...u.pathname.split('/'), ...u.searchParams.values())
  } catch {
    // not a parseable URL: only the raw string can be matched
  }
  const parts = [
    ...always.flatMap(uriVariants).filter((p) => p.length > 0),
    ...pieces.flatMap(uriVariants).filter((p) => p.length >= MIN_SECRET_PART),
  ]
  return [...new Set(parts)].sort((a, b) => b.length - a.length)
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Replaces the RPC URL, its host and every key-like piece of it with [redacted], ignoring case. */
export function redactRpc(text: string, url: string | undefined): string {
  if (!url) return text
  return text.replace(new RegExp(secretParts(url).map(escapeRegExp).join('|'), 'gi'), REDACTED)
}

/**
 * Routes console.log, console.warn and console.error through redactRpc until the process exits, so web3.js's own
 * lines ("ws error: ...", 429 retry notices, socket-close errors) are redacted too.
 */
function redactConsole(currentUrl: () => string | undefined): void {
  const original = { log: console.log, warn: console.warn, error: console.error }
  const wrap = (write: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => write(redactRpc(format(...args), currentUrl()))
  console.log = wrap(original.log)
  console.warn = wrap(original.warn)
  console.error = wrap(original.error)
  process.once('exit', () => Object.assign(console, original))
}

/** First line of an error's message, redacted. */
export function errorLine(err: unknown, url: string | undefined): string {
  return redactRpc(err instanceof Error ? err.message.split('\n')[0] : String(err), url)
}

/** Full error report (stack, cause chain), redacted. A UsageError prints its message only. */
export function describeError(err: unknown, url: string | undefined): string {
  return err instanceof UsageError ? err.message : redactRpc(inspect(err), url)
}

/**
 * Entry point for scripts that may talk to a private RPC. `main` gets the `--rpc` URL (undefined without the flag).
 * Console output is redacted for the life of the process. Every error, including unhandled rejections from inside
 * web3.js, is printed redacted. After the first one, `onError` runs once (e.g. to return trader SOL), then the process
 * exits 2 on a UsageError and 1 otherwise.
 */
export function runRpcScript(main: (rpc: string | undefined) => Promise<void>, onError?: () => Promise<void>): void {
  let rpc: string | undefined
  let failed = false
  redactConsole(() => rpc)
  const fail = async (err: unknown): Promise<void> => {
    console.error(describeError(err, rpc))
    if (failed) return
    failed = true
    await onError?.().catch((e: unknown) => console.error(`cleanup failed: ${describeError(e, rpc)}`))
    process.exit(err instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE)
  }
  process.on('unhandledRejection', fail)
  process.on('uncaughtException', fail)
  const run = async () => {
    rpc = rpcFromArgs(process.argv.slice(2))
    await main(rpc)
  }
  run().catch(fail)
}

export function rpcChain(url: string, funder: Keypair): Chain {
  const connection = new Connection(url, 'confirmed')
  return {
    name: chainLabel(url),
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
        return { ok: false, error: `${errorLine(err, url)} :: ${redactRpc(logs, url)}` }
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
