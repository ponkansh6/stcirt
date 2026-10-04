#!/usr/bin/env bash
set -uo pipefail

REF="${1:-HEAD}"
ROOT=$(git rev-parse --show-toplevel)

echo "[head-typecheck] Checking committed tree at ref: $REF"

WT=$(mktemp -d)
trap 'git worktree remove --force "$WT" 2>/dev/null; rm -rf "$WT"' EXIT

if ! git worktree add --detach "$WT" "$REF" >/dev/null 2>&1; then
  echo "[head-typecheck] ❌ Failed to create worktree for ref $REF"
  exit 1
fi

if [ ! -d "$ROOT/node_modules" ]; then
  echo "[head-typecheck] ❌ node_modules not found at root"
  exit 1
fi

ln -s "$ROOT/node_modules" "$WT/node_modules"

if "$ROOT/node_modules/.bin/tsgo" --noEmit -p "$WT/tsconfig.json"; then
  echo "[head-typecheck] OK: Commited tree at $REF type-checks successfully."
  exit 0
else
  echo ""
  echo "❌ 作業ツリーは通るがコミット済みツリーが壊れている ＝ コミット漏れがあります (HEAD type-check failed)"
  echo "   (例: 型定義の変更が不完全なままファイルがコミットされていない等)"
  echo ""
  exit 1
fi
