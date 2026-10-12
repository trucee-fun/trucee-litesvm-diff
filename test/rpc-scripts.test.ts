import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { Keypair } from '@solana/web3.js'

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const RPC_URL = 'http://127.0.0.1:3124/private-test-provider-key'
const ROOT = resolve(__dirname, '..')
const TEMP = mkdtempSync(join(tmpdir(), 'trucee-rpc-tests-'))
const TRADERS = join(TEMP, 'empty.traders.json')
const E2E = join(TEMP, 'e2e.json')
const POOL = Keypair.generate().publicKey.toBase58()
let genesis = DEVNET_GENESIS
let methods: string[] = []
let server: Server

before(async () => {
  const keyDir = join(TEMP, '.config', 'solana')
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(join(keyDir, 'id.json'), JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 })
  writeFileSync(TRADERS, '[]')
  writeFileSync(E2E, JSON.stringify({ accounts: { base_mint: POOL, quote_mint: 'So11111111111111111111111111111111111111112' } }))
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      const message = JSON.parse(body) as { id: string; method: string }
      methods.push(message.method)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(message.method === 'getGenesisHash'
        ? { jsonrpc: '2.0', id: message.id, result: genesis }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `test RPC failure at ${RPC_URL}` } }))
    })
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(3124, '127.0.0.1', resolveListen)
  })
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  rmSync(TEMP, { recursive: true, force: true })
})

async function run(file: string, args: readonly string[], rpc: string | null = RPC_URL, home = TEMP) {
  methods = []
  const env = { ...process.env, HOME: home, DEVNET_RPC: rpc ?? undefined }
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', file), ...args], { cwd: ROOT, env })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', resolveExit)
  })
  return { code, output }
}

test('reclaim refuses a non-devnet RPC before loading wallets or sending', async () => {
  genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
  const result = await run('reclaim_test_wallets.ts', [join(TEMP, 'missing.traders.json'), '--rpc', 'env'], RPC_URL, join(TEMP, 'missing-home'))
  assert.equal(result.code, 1)
  assert.match(result.output, /devnet genesis hash/)
  assert.deepEqual(methods, ['getGenesisHash'])
})

test('reclaim accepts devnet and safely skips an empty trader list', async () => {
  genesis = DEVNET_GENESIS
  const result = await run('reclaim_test_wallets.ts', [TRADERS, '--rpc', 'env'])
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(methods, ['getGenesisHash'])
})

for (const [file, args] of [
  ['damm_swap_devnet.ts', [E2E, POOL]],
  ['damm_fee_probe.ts', [POOL]],
] as const) {
  test(`${file} reads the env RPC and redacts failures`, async () => {
    const result = await run(file, [...args, '--rpc', 'env'])
    assert.equal(result.code, 1, result.output)
    assert.ok(methods.includes('getAccountInfo'), result.output)
    assert.match(result.output, /test RPC failure/)
    assert.ok(!result.output.includes(RPC_URL), result.output)
    assert.ok(!result.output.includes('private-test-provider-key'), result.output)
  })

  test(`${file} reports a missing env RPC as a usage error`, async () => {
    const result = await run(file, [...args, '--rpc', 'env'], null)
    assert.equal(result.code, 2, result.output)
    assert.match(result.output, /DEVNET_RPC is not set/)
    assert.deepEqual(methods, [])
  })
}
