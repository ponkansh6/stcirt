#!/usr/bin/env bash
set -uo pipefail

AUDIT_JSON=$(pnpm audit --audit-level=high --json 2>/dev/null || true)

# Parse audit output using node to check for vulnerabilities
HAS_VULN_RESULT=$(node -e '
try {
  const data = JSON.parse(process.argv[1]);
  const vuln = data.metadata?.vulnerabilities;
  if (vuln && typeof vuln === "object") {
    const high = vuln.high || 0;
    const critical = vuln.critical || 0;
    console.log(high + critical > 0 ? "YES" : "NO");
  } else {
    console.log("NO");
  }
} catch {
  console.log("PARSE_ERROR");
}
' "$AUDIT_JSON")

if [ "$HAS_VULN_RESULT" = "PARSE_ERROR" ]; then
  if [ -n "${CI:-}" ]; then
    echo "[security] ❌ pnpm audit の解析に失敗しました (CI 环境)"
    exit 1
  else
    echo "[security] ⚠ pnpm audit を実行できませんでした（ネットワーク/レジストリ到達不能）。ローカルではスキップします。"
    exit 0
  fi
elif [ "$HAS_VULN_RESULT" = "YES" ]; then
  echo ""
  echo "[security] ❌ High/Critical 脆弱性が検出されました"
  pnpm audit --audit-level=high
  exit 1
fi

echo "[security] Running secretlint..."
if ! pnpm exec secretlint "**/*"; then
  echo "[security] ❌ secretlint 検出エラー"
  exit 1
fi

echo "[security] ✅ OK"
exit 0
