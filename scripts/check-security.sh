#!/usr/bin/env bash
set -uo pipefail

PROD_AUDIT_JSON=''
if PROD_AUDIT_JSON=$(pnpm audit --prod --audit-level=high --json 2>&1); then
  PROD_AUDIT_STATUS=0
else
  PROD_AUDIT_STATUS=$?
fi

# pnpm exits non-zero when the configured threshold is met. Parse the report
# first so vulnerability findings can be distinguished from audit failures.
PROD_AUDIT_RESULT=$(node -e '
try {
  const data = JSON.parse(process.argv[1]);
  const vulnerabilities = data.metadata?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object") {
    console.log("INVALID");
  } else {
    const high = Number(vulnerabilities.high || 0);
    const critical = Number(vulnerabilities.critical || 0);
    console.log(high + critical > 0 ? "VULNERABLE" : "CLEAN");
  }
} catch {
  console.log("INVALID");
}
' "$PROD_AUDIT_JSON")

if [ "$PROD_AUDIT_RESULT" = "INVALID" ] || { [ "$PROD_AUDIT_STATUS" -ne 0 ] && [ "$PROD_AUDIT_RESULT" = "CLEAN" ]; }; then
  echo "[security][prod] ❌ 本番依存の pnpm audit に失敗しました。監査結果を確認できないためブロックします。"
  printf '%s\n' "$PROD_AUDIT_JSON"
  exit 1
elif [ "$PROD_AUDIT_RESULT" = "VULNERABLE" ]; then
  echo "[security][prod] ❌ 本番依存に High/Critical 脆弱性が検出されました。"
  printf '%s\n' "$PROD_AUDIT_JSON"
  exit 1
fi
echo "[security][prod] ✅ High/Critical 脆弱性はありません。"

DEV_AUDIT_JSON=''
if DEV_AUDIT_JSON=$(pnpm audit --dev --json 2>&1); then
  DEV_AUDIT_STATUS=0
else
  DEV_AUDIT_STATUS=$?
fi

DEV_AUDIT_RESULT=$(node -e '
try {
  const data = JSON.parse(process.argv[1]);
  const vulnerabilities = data.metadata?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object") {
    console.log("INVALID");
  } else {
    const total = Object.values(vulnerabilities).reduce((sum, count) => sum + (Number(count) || 0), 0);
    console.log(total > 0 ? "VULNERABLE" : "CLEAN");
  }
} catch {
  console.log("INVALID");
}
' "$DEV_AUDIT_JSON")

if [ "$DEV_AUDIT_RESULT" = "INVALID" ] || { [ "$DEV_AUDIT_STATUS" -ne 0 ] && [ "$DEV_AUDIT_RESULT" = "CLEAN" ]; }; then
  echo "[security][dev] ⚠ 開発依存の監査を完了できませんでした。監査結果を確認してください（ブロックしません）。"
  printf '%s\n' "$DEV_AUDIT_JSON"
elif [ "$DEV_AUDIT_RESULT" = "VULNERABLE" ]; then
  echo "[security][dev] ⚠ 開発依存に脆弱性があります（ブロックしません）。監査の詳細:"
  printf '%s\n' "$DEV_AUDIT_JSON"
else
  echo "[security][dev] ✅ 脆弱性はありません。"
fi

echo "[security] Running secretlint..."
if ! pnpm exec secretlint "**/*"; then
  echo "[security] ❌ secretlint 検出エラー"
  exit 1
fi

echo "[security] ✅ OK"
exit 0
