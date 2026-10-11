#!/usr/bin/env bash
# Fetches Meteora's DBC program binaries for the LiteSVM suites and the SDK's
# LiteSVM tests. They are not committed: the DBC program is under Meteora's
# licence (https://github.com/MeteoraAg/dynamic-bonding-curve), so each checkout
# dumps its own copy from chain.
#
#   programs/dbc.so         mainnet-beta DBC (the default for every suite)
#   programs/dbc_devnet.so  devnet DBC
#
# Read-only: `solana program dump` against the public mainnet-beta and devnet
# RPCs. No keypair, no provider URL, no SOL spent. Safe to re-run; it overwrites
# both files. Prints each path with its sha256.
# Usage: cd litesvm-diff && bash scripts/fetch-dbc.sh
set -euo pipefail

readonly DBC_PROGRAM_ID=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
readonly MAX_ATTEMPTS=3
readonly BACKOFF_SECONDS=5

if ! command -v solana >/dev/null 2>&1; then
  echo "fetch-dbc: the solana CLI is required" >&2
  exit 2
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p programs

# usage: dump <cluster moniker flag> <output path>; retries public RPC rate limits.
dump() {
  local attempt
  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    if solana program dump "$1" "$DBC_PROGRAM_ID" "$2" >/dev/null; then
      return 0
    fi
    if ((attempt < MAX_ATTEMPTS)); then
      sleep $((attempt * BACKOFF_SECONDS))
    fi
  done
  echo "fetch-dbc: could not dump $2 after $MAX_ATTEMPTS attempts" >&2
  return 1
}

dump -um programs/dbc.so
dump -ud programs/dbc_devnet.so

shasum -a 256 programs/dbc.so programs/dbc_devnet.so
