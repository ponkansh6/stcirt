#!/bin/sh
set -eu

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

DIRTY=$( {
  git diff --cached --name-only
  git diff --name-only
  git ls-files --others --exclude-standard
} | sort -u )

if [ -z "$DIRTY" ]; then
  exit 0
fi

echo ""
echo "❌ 未コミットの変更があります。push を中止しました。"
echo "$DIRTY" | sed 's/^/   - /'
echo ""
echo "変更はコミットするか stash してください。不要な未追跡ファイルは .gitignore に追加してください。"
echo ""
exit 1
