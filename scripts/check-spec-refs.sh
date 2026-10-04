#!/usr/bin/env bash
# check-spec-refs.sh
# Pre-push / CI check: verifies that all `src/` and `tests/` file references
# in spec.md actually exist in the working tree.
#
# Exit 1 if any reference points to a non-existent file or directory.
# This prevents spec.md from accumulating stale/rotten references when
# modules are renamed or removed.

set -euo pipefail

SPEC_FILE="openspec/specs/stcirt/spec.md"

if [ ! -f "$SPEC_FILE" ]; then
  echo "[spec-refs] spec.md not found — skipping validation."
  exit 0
fi

echo "[spec-refs] Checking spec.md file references..."

# ── Extract file/dir references from spec.md ────────────────────────────
# Matches backtick-quoted paths starting with src/ or tests/.
# Examples:
#   `src/lib/db/schema.ts`       → file
#   `src/lib/news/`              → directory
#   `tests/db/actions.test.ts`   → file
#   `news/{zenn,qiita,...}.ts`   → brace expansion (handle below)
REFS=$(grep -oP '`((src|tests)/[^`]+)' "$SPEC_FILE" 2>/dev/null | sed 's/`//g' || true)

if [ -z "$REFS" ]; then
  echo "[spec-refs] No source references found in spec.md."
  exit 0
fi

# ── Validate each reference ─────────────────────────────────────────────
MISSING=0
# Track seen refs to avoid duplicate error messages
declare -A SEEN

while IFS= read -r ref; do
  # Skip duplicates
  if [ "${SEEN[$ref]:-}" = "1" ]; then
    continue
  fi
  SEEN[$ref]="1"

  # Handle brace expansion patterns (e.g., `news/{zenn,qiita,...}.ts`)
  if [[ "$ref" == *\{* ]]; then
    # Extract the base path and the brace contents
    base="${ref%%\{*}"
    brace_part="${ref#*{}"
    brace_part="${brace_part%\}}"
    suffix="${ref##*\}}"

    IFS=',' read -ra items <<< "$brace_part"
    for item in "${items[@]}"; do
      expanded="${base}${item}${suffix}"
      if [ ! -f "$expanded" ] && [ ! -d "$expanded" ]; then
        echo "  ❌ Stale reference: \`$expanded\` (expanded from \`$ref\`)"
        MISSING=$((MISSING + 1))
      fi
    done
    continue
  fi

  # Handle glob patterns (e.g., `admin/db/[table]/components/*.tsx`)
  if [[ "$ref" == *\** ]]; then
    # Glob patterns are intentional — skip existence check (they're matched at runtime)
    continue
  fi

  # Normal file/dir reference
  if [ -f "$ref" ] || [ -d "$ref" ]; then
    continue
  fi

  echo "  ❌ Stale reference: \`$ref\`"
  MISSING=$((MISSING + 1))
done <<< "$REFS"

# ── Summary ─────────────────────────────────────────────────────────────
if [ "$MISSING" -gt 0 ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║  spec.md contains $MISSING reference(s) to non-existent files.         ║"
  echo "║  Update spec.md to remove or fix stale references.             ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Tip: These references may be leftover from renamed/removed modules."
  echo "     Search spec.md for the file paths above and update them."
  exit 1
fi

echo "[spec-refs] ✅ All spec.md file references are valid."
exit 0
