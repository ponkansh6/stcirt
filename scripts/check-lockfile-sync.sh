#!/usr/bin/env bash
set -euo pipefail

echo "[lockfile] Checking package.json / pnpm-lock.yaml sync..."

if pnpm install --frozen-lockfile --lockfile-only >/dev/null 2>&1; then
  echo "[lockfile] OK"
  exit 0
else
  echo ""
  echo "❌ package.json と pnpm-lock.yaml が同期していません（CI の \`pnpm install --frozen-lockfile\` が落ちます）"
  echo "   → \`pnpm install\` を実行し、package.json と pnpm-lock.yaml を **両方** コミットしてください"
  echo ""
  # Re-run without redirection so pnpm output is visible
  pnpm install --frozen-lockfile --lockfile-only || true
  exit 1
fi
