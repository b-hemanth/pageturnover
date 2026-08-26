#!/usr/bin/env bash
set -euo pipefail

PAGETURNOVER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$PAGETURNOVER_ROOT/scripts/serve-production.mjs"
