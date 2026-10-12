# Trucee LiteSVM comparisons

Runs the real Meteora DBC program inside LiteSVM, records swaps for comparison with the Python port, and exercises Trucee router/hook behavior. Local suites execute program binaries in memory and do not send cluster transactions. Separate devnet scripts exercise migration and DAMM v2 trading.

The router's floor holds until graduation: recorded basis minus the fee at cost (at most 1%) minus a 2-lamport haircut. Exits happen before graduation. `init_market` rejects a static fee above 100 bps (numerator `10000000`) with `FeeTooHigh` (`6024`, `Config fee is above the 1% cap`).

## Workspace and dependencies

Use Node.js 24, npm and the Solana/Agave SBF toolchain (`cargo build-sbf`). Python 3 is needed for replaying recordings. Clone the repositories side by side with these folder names so program and replay paths resolve:

```sh
mkdir trucee && cd trucee
git clone https://github.com/trucee-fun/trucee-programs zpvp
git clone https://github.com/trucee-fun/trucee-sdk sdk
git clone https://github.com/trucee-fun/trucee-app app
git clone https://github.com/trucee-fun/trucee-sim sim
git clone https://github.com/trucee-fun/trucee-worker worker
git clone https://github.com/trucee-fun/trucee-litesvm-diff litesvm-diff
git clone https://github.com/trucee-fun/trucee-docs gitbook
cd litesvm-diff
npm ci
npm test
```

`npm test` runs the offline RPC-script regression tests in `test/rpc-scripts.test.ts`: refusal of a non-devnet reclaim endpoint, acceptance of devnet, env-based DAMM RPC selection, missing-env errors and URL redaction. Its temporary mock RPC listens on localhost port `3124`. The program suites below are separate commands and require built `.so` files.

## Build the program binaries

From the workspace folder, build the hook and the default router from [trucee-programs](https://github.com/trucee-fun/trucee-programs/blob/main/Anchor.toml):

```sh
cd zpvp
cargo build-sbf --manifest-path programs/zpvp_hook/Cargo.toml --sbf-out-dir target/deploy
cargo build-sbf --manifest-path programs/zpvp_router/Cargo.toml --sbf-out-dir target/deploy
cd ../litesvm-diff
```

Default paths are `../zpvp/target/deploy/zpvp_hook.so`, `../zpvp/target/deploy/zpvp_router.so` and `programs/dbc.so`. `HOOK_SO`, `ROUTER_SO` and `DBC_SO` override them. Use a current source build when testing current behavior; a stored binary or devnet recording describes its own revision.

Some suites create custom quote mints or use curves larger than the normal launch caps. Build a separate router with its test-only `unrestricted` feature, which lifts the quote allowlist and graduation-threshold caps:

```sh
cd ../zpvp
cargo build-sbf --manifest-path programs/zpvp_router/Cargo.toml --sbf-out-dir ../litesvm-diff/programs/unrestricted --features unrestricted
cd ../litesvm-diff
```

DBC binaries are excluded from the source repository under Meteora's licensing terms. `scripts/fetch-dbc.sh` retrieves both `programs/dbc.so` and `programs/dbc_devnet.so` using read-only program dumps from public cluster RPCs, without signing keys. Supply these binaries separately if working offline. See the [upstream terms](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/main/LICENSE).

## What the suites check

| File | Scope of its checks |
| --- | --- |
| `harness.ts` | Records DBC buy/sell deltas, price and reserves for Python differential replay. |
| `zpvp_e2e.ts` | Router buys, before-graduation refunds, hook enforcement, graduation, finalization and surplus claims. |
| `zpvp_negative.ts` | Rejects substituted accounts, unsupported fee modes, mutable-owner base accounts, hook bypasses and invalid lifecycle calls. |
| `zpvp_auto_exit.ts` | Deadline storage/clearing, delegated before-graduation refunds, chain-clock eligibility and rejected account substitutions. |
| `zpvp_anti_whale.ts` | Enforces the 20% position cap and graduates a curve through spread buys. |
| `zpvp_referral.ts` | Referral accounts receive DBC's protocol-fee share without changing buyer basis or later refunds before graduation; rejects malformed remaining accounts. |
| `zpvp_preset.ts` | Rejects creator allocations, withdrawable LP, migration-fee cuts, mutable token authority and other unsupported launch settings. |
| `zpvp_caps.ts` | Quote-mint allowlist and graduation-threshold boundaries for wSOL and xStocks. |
| `zpvp_xstocks.ts` | Token-2022 xStock quotes, fixture validation, before-graduation refunds, graduation and surplus claims. |
| `rsc01_injected_ixs.ts` | Router calls still work around memo/compute-budget instructions; direct token transfers are rejected before graduation. Optional Lighthouse cases require `LIGHTHOUSE_SO`. |

`fixture.ts` builds accounts and instructions shared by the suites. `chain.ts` selects LiteSVM or RPC execution and redacts private RPC URLs. The xStock fixtures are stored account snapshots; test balances are injected into LiteSVM, rather than minted using a real xStock authority. The [router v5 security review](https://github.com/trucee-fun/trucee-docs/blob/main/security/router-v5-review.md) describes findings and remaining limitations; these tests establish only the cases they exercise.

## Local commands

The capped-router cases use the 1% tiny/small scenarios. The custom-quote cases use the unrestricted binary and index `1` of `scenarios.json` (a 1% fee); other recorded DBC configurations may exceed the current router fee cap.

```sh
npx tsx src/zpvp_e2e.ts out/scenario_tiny.json 0 out/e2e_local.json --wsol
npx tsx src/zpvp_caps.ts out/scenarios.json out/scenario_small.json
npx tsx src/zpvp_xstocks.ts out/scenario_small.json 0
npx tsx src/rsc01_injected_ixs.ts out/scenario_tiny.json 0
ROUTER_SO=programs/unrestricted/zpvp_router.so npx tsx src/zpvp_negative.ts out/scenarios.json 1
ROUTER_SO=programs/unrestricted/zpvp_router.so npx tsx src/zpvp_auto_exit.ts out/scenarios.json 1
ROUTER_SO=programs/unrestricted/zpvp_router.so npx tsx src/zpvp_anti_whale.ts out/scenarios.json 1
ROUTER_SO=programs/unrestricted/zpvp_router.so npx tsx src/zpvp_referral.ts out/scenarios.json 1
ROUTER_SO=programs/unrestricted/zpvp_router.so npx tsx src/zpvp_preset.ts out/scenarios.json 1
```

The optional `LIGHTHOUSE_SO` supplies a locally available Lighthouse program binary; without it those cases report `SKIP`.

Replays need only Python and the committed recordings:

```sh
cd ../sim
python3 replay_diff.py ../litesvm-diff/out/results.json
python3 replay_diff.py ../litesvm-diff/out/results_b.json
```

The recordings contain 9,000 and 12,000 DBC swaps respectively, with 21,000 exact matches and zero mismatches. Generate a fresh DBC comparison, or a harness result for the tiny router scenario, from `litesvm-diff/`:

```sh
python3 ../sim/export_configs.py out/scenarios_local.json --count 3 --seed 90000
npx tsx src/harness.ts out/scenarios_local.json out/results_local.json 20
python3 ../sim/replay_diff.py out/results_local.json
npx tsx src/harness.ts out/scenario_tiny.json out/results_tiny_local.json 20
python3 ../sim/replay_router.py out/e2e_local.json out/results_tiny_local.json
```

## Devnet commands

Store `DEVNET_RPC` in a gitignored `.env` or set it in your environment. Load the file with `node --env-file=.env --import tsx` in place of `npx tsx`, then pass `--rpc env`. The shared entrypoint reads the URL from `DEVNET_RPC`, redacts console output and errors, and exits `2` for usage errors or `1` for runtime failures. Keep the payer keypair at `~/.config/solana/id.json`.

| Script | What it does |
| --- | --- |
| `zpvp_e2e.ts ... --rpc env --wsol` | Creates its own devnet market and throwaway trader wallets, runs the router journey and writes a public result plus a gitignored `*.traders.json` key file. |
| `migrate_devnet.ts` | Migrates the completed pool from an E2E result into DAMM v2. |
| `damm_swap_devnet.ts` | Buys and sells the migrated token through DAMM v2. |
| `damm_fee_probe.ts` | Quotes the seller fee; `--push-quote` additionally sends a buy and measures the changed fee. |
| `reclaim_test_wallets.ts` | Closes generated traders' wSOL accounts and returns their devnet SOL to the payer; empty wallets are skipped. |

Reclaiming refuses to load wallet keys or send unless the RPC returns devnet's genesis hash, `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, matching the worker's devnet-script guard. The other live scripts in this repository do not perform that genesis check.

```sh
npx tsx src/zpvp_e2e.ts out/scenario_tiny.json 0 out/e2e_live.json --rpc env --wsol --ops 12
npx tsx src/migrate_devnet.ts out/e2e_live.json --rpc env
npx tsx src/damm_swap_devnet.ts out/e2e_live.json DAMM_POOL --rpc env
npx tsx src/damm_fee_probe.ts DAMM_POOL --rpc env
npx tsx src/damm_fee_probe.ts DAMM_POOL --push-quote 10000000 --rpc env
npx tsx src/reclaim_test_wallets.ts out/e2e_live.json.traders.json --rpc env
```

`DAMM_POOL` is the public pool address returned by migration. DAMM scripts default to the public devnet RPC when `--rpc` is absent. Live trading scripts fund accounts and send transactions; the fee probe sends only when `--push-quote` is supplied. Reclaiming operates on keys generated by these E2E scripts, stored in gitignored `*.traders.json` files.

The injected-instruction script also has a read-only devnet simulation mode using its public RPC. `USER_REF` selects a signature key or `op:N` from the recording; no private keys are loaded or transactions sent:

```sh
npx tsx src/rsc01_injected_ixs.ts --devnet out/e2e_devnet_v4.json USER_REF
npx tsx src/rsc01_injected_ixs.ts --devnet-live out/e2e_devnet_v4.json USER_REF
```

## Retained recordings

| File in `out/` | Why it is retained |
| --- | --- |
| `results.json`, `results_b.json` | The 21,000-swap DBC replay evidence used by published docs and app proof links. |
| `scenarios.json` | DBC curve configurations used by local suites and referenced by published docs. |
| `scenario_small.json`, `scenario_tiny.json` | Small 1% curves used by suites, SDK tests and worker demo preparation. |
| `e2e_devnet_v4.json` | Public account/signature fixture for injected-instruction simulation and SDK PDA tests. |
| `e2e_devnet_v6.json` | Historical router E2E evidence referenced by published docs. |

## License

Trucee-authored code is MIT; see [LICENSE](https://github.com/trucee-fun/trucee-litesvm-diff/blob/main/LICENSE). Retrieved DBC binaries remain subject to Meteora's terms.
