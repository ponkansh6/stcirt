#!/usr/bin/env bash
set -Eeuo pipefail

# Disposable compatibility spike for the current working tree. This script is
# the sole owner of its temporary git worktree and always removes it on exit.
# It runs a production build and a synthetic browser probe for route Activity,
# ResultsPanel state/effect behavior, and unsent owner answer-draft retention.
# Submitted-answer lifecycle and production compatibility acceptance remain out
# of scope.

ROOT=$(git rev-parse --show-toplevel)
NODE_MODULES="$ROOT/node_modules"

if [[ ! -d "$NODE_MODULES" ]]; then
  echo "[cache-components-spike] FAIL: root node_modules not found" >&2
  exit 1
fi

if ! node -e 'const [major] = process.versions.node.split(".").map(Number); process.exit(major >= 24 ? 0 : 1)'; then
  echo "[cache-components-spike] FAIL: Next 16.3 requires Node.js 24 or newer" >&2
  exit 1
fi

TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/stcirt-cache-components-spike.XXXXXX")
WORKTREE="$TEMP_ROOT/worktree"
PATCH_FILE="$TEMP_ROOT/working-tree.patch"
WORKTREE_ADDED=0
ACTIVE_CHILD_PID=""

stop_active_child() {
  local signal=${1:-TERM}
  if [[ -z "$ACTIVE_CHILD_PID" ]]; then return; fi
  local child_pid=$ACTIVE_CHILD_PID
  if kill -0 -- "-$child_pid" 2>/dev/null; then
    kill -"$signal" -- "-$child_pid" 2>/dev/null || true
    for _ in {1..30}; do
      if ! kill -0 -- "-$child_pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if kill -0 -- "-$child_pid" 2>/dev/null; then
      kill -KILL -- "-$child_pid" 2>/dev/null || true
    fi
  else
    kill -"$signal" "$child_pid" 2>/dev/null || true
  fi
  wait "$child_pid" 2>/dev/null || true
  ACTIVE_CHILD_PID=""
}

on_signal() {
  local signal=$1
  local exit_status=$2
  trap - INT TERM HUP
  stop_active_child TERM
  exit "$exit_status"
}

run_logged() {
  local log_file=$1
  local work_dir=$2
  shift 2
  if ! command -v setsid >/dev/null 2>&1; then
    echo "[cache-components-spike] FAIL: setsid is required for safe child cleanup" >&2
    return 1
  fi
  setsid bash -c 'cd "$1" && shift && exec "$@"' bash "$work_dir" "$@" >"$log_file" 2>&1 &
  ACTIVE_CHILD_PID=$!
  local child_status=0
  wait "$ACTIVE_CHILD_PID" || child_status=$?
  ACTIVE_CHILD_PID=""
  return "$child_status"
}

run_captured() {
  local stdout_file=$1
  local stderr_file=$2
  local work_dir=$3
  shift 3
  if ! command -v setsid >/dev/null 2>&1; then
    echo "[cache-components-spike] FAIL: setsid is required for safe child cleanup" >&2
    return 1
  fi
  setsid bash -c 'cd "$1" && shift && exec "$@"' bash "$work_dir" "$@" >"$stdout_file" 2>"$stderr_file" &
  ACTIVE_CHILD_PID=$!
  local child_status=0
  wait "$ACTIVE_CHILD_PID" || child_status=$?
  ACTIVE_CHILD_PID=""
  return "$child_status"
}

cleanup() {
  local result=$?
  trap - EXIT
  stop_active_child TERM
  if [[ "$WORKTREE_ADDED" == 1 ]]; then
    git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || {
      echo "[cache-components-spike] WARNING: worktree removal failed; git metadata may need cleanup" >&2
    }
  fi
  rm -rf -- "$TEMP_ROOT"
  exit "$result"
}
trap cleanup EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP

echo "[cache-components-spike] Creating disposable worktree at current HEAD"
git -C "$ROOT" worktree add --detach "$WORKTREE" HEAD >/dev/null
WORKTREE_ADDED=1

# Carry tracked source/config/spec changes from the user's working tree, while
# excluding environment and credential material by path. No environment file
# is ever copied, including one accidentally committed in the current branch.
git -C "$ROOT" diff --binary HEAD -- \
  . \
  ':(exclude,icase,glob).env*' \
  ':(exclude,icase,glob)**/.env*' \
  ':(exclude,glob)**/*credential*' \
  ':(exclude,glob)**/*credentials*' \
  ':(exclude,glob)**/*secret*' \
  ':(exclude,glob)**/*.pem' \
  ':(exclude,glob)**/*.key' >"$PATCH_FILE"

if [[ -s "$PATCH_FILE" ]]; then
  git -C "$WORKTREE" apply --whitespace=nowarn "$PATCH_FILE"
fi

# Only these known, related untracked artifacts are admitted. This is an exact
# allowlist; arbitrary untracked files and all .env/credential files stay out.
for relative_path in \
  src/app/results/error.tsx \
  tests/results/results-error.test.tsx \
  docs/performance/shared-plan68-evidence.md; do
  source_path="$ROOT/$relative_path"
  if [[ -f "$source_path" && ! -L "$source_path" ]]; then
    mkdir -p "$WORKTREE/$(dirname "$relative_path")"
    cp -- "$source_path" "$WORKTREE/$relative_path"
  fi
done

# Remove any environment files present in HEAD as well. The build receives a
# deliberately small environment and cannot contact Turso or use real auth.
find "$WORKTREE" \( -type f -o -type l \) \( \
  -iname '.env*' -o \
  -iname '*credential*' -o \
  -iname '*credentials*' -o \
  -iname '*secret*' -o \
  -iname '*.pem' -o \
  -iname '*.key' \
\) -delete
ln -s "$NODE_MODULES" "$WORKTREE/node_modules"

CONFIG="$WORKTREE/next.config.ts"
if [[ ! -f "$CONFIG" ]] || [[ $(grep -Fc 'const nextConfig: NextConfig = {' "$CONFIG") != 1 ]]; then
  echo "[cache-components-spike] FAIL: could not safely locate NextConfig object" >&2
  exit 1
fi

# Establish the non-Cache-Components baseline in the disposable copy first.
# Both baseline and candidate use separate output directories.
node - "$CONFIG" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const marker = 'const nextConfig: NextConfig = {';
if (source.includes('cacheComponents:')) {
  console.error('[cache-components-spike] FAIL: next.config.ts already defines cacheComponents');
  process.exit(1);
}
const replacement = `${marker}\n  cacheComponents: false,\n  distDir: ".next-cache-components-baseline",`;
fs.writeFileSync(file, source.replace(marker, replacement));
NODE

# Disable the optional remote Google font once, before either build, so both
# sides share the same offline-only presentation condition.
node - "$WORKTREE/src/app/layout.tsx" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const fileStat = fs.lstatSync(file);
if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
  console.error('[cache-components-spike] FAIL: layout must be a regular non-symlink file in scratch worktree');
  process.exit(1);
}
let source = fs.readFileSync(file, 'utf8');
const importLine = 'import { Geist } from "next/font/google";\n';
const geistSetup = `const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});
`;
const htmlClass = '<html lang="ja" className={geist.variable}>';
if (
  source.split(importLine).length !== 2 ||
  source.split(geistSetup).length !== 2 ||
  source.split(htmlClass).length !== 2
) {
  console.error('[cache-components-spike] FAIL: could not safely disable next/font/google in the disposable copy');
  process.exit(1);
}
source = source.replace(importLine, '').replace(geistSetup, '').replace(htmlClass, '<html lang="ja">');
fs.writeFileSync(file, source);
console.log('[cache-components-spike] Applied the same offline font exclusion before baseline and candidate');
NODE

BASELINE_BUILD_LOG="$TEMP_ROOT/baseline-build.log"
BASELINE_MEASURE_LOG="$TEMP_ROOT/baseline-measure.log"
BASELINE_METRICS="$TEMP_ROOT/baseline-metrics.json"
TS_CONFIG_BACKUP="$TEMP_ROOT/tsconfig.before-build.json"
NEXT_ENV_BACKUP="$TEMP_ROOT/next-env.before-build.d.ts"
NEXT_ENV_EXISTED=0
if [[ ! -f "$WORKTREE/tsconfig.json" || -L "$WORKTREE/tsconfig.json" ]]; then
  echo "[cache-components-spike] FAIL: scratch tsconfig.json must be a regular file" >&2
  exit 1
fi
cp -- "$WORKTREE/tsconfig.json" "$TS_CONFIG_BACKUP"
if [[ -f "$WORKTREE/next-env.d.ts" && ! -L "$WORKTREE/next-env.d.ts" ]]; then
  cp -- "$WORKTREE/next-env.d.ts" "$NEXT_ENV_BACKUP"
  NEXT_ENV_EXISTED=1
elif [[ -e "$WORKTREE/next-env.d.ts" || -L "$WORKTREE/next-env.d.ts" ]]; then
  echo "[cache-components-spike] FAIL: scratch next-env.d.ts must be a regular file when present" >&2
  exit 1
fi
echo "[cache-components-spike] Building current-source baseline with cacheComponents disabled"
if run_logged "$BASELINE_BUILD_LOG" "$WORKTREE" \
  env -i PATH="$PATH" NODE_ENV=production CI=1 NEXT_TELEMETRY_DISABLED=1 \
  "$NODE_MODULES/.bin/next" build --webpack; then
  cat "$BASELINE_BUILD_LOG"
else
  baseline_build_status=$?
  cat "$BASELINE_BUILD_LOG"
  echo "[cache-components-spike] RESULT: INCONCLUSIVE (baseline build failed with status $baseline_build_status)" >&2
  exit "$baseline_build_status"
fi

echo "[cache-components-spike] Measuring synthetic baseline with the normal results-page harness"
if run_captured "$BASELINE_METRICS" "$BASELINE_MEASURE_LOG" "$WORKTREE" \
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" RESULTS_BENCH_SAMPLES=5 \
  node scripts/measure-results-page.mjs; then
  cat "$BASELINE_MEASURE_LOG"
else
  baseline_measure_status=$?
  cat "$BASELINE_MEASURE_LOG"
  echo "[cache-components-spike] RESULT: INCONCLUSIVE (baseline synthetic measurement failed with status $baseline_measure_status)" >&2
  exit "$baseline_measure_status"
fi

# Next may edit generated type includes during build. Reset those build inputs
# before applying candidate-only transforms so both builds begin identically.
cp -- "$TS_CONFIG_BACKUP" "$WORKTREE/tsconfig.json"
if [[ "$NEXT_ENV_EXISTED" == 1 ]]; then
  cp -- "$NEXT_ENV_BACKUP" "$WORKTREE/next-env.d.ts"
else
  rm -f -- "$WORKTREE/next-env.d.ts"
fi

# Cache Components requires request-bound searchParams/cookies to sit behind a
# Suspense boundary. Preserve the presenter auth gate inside that child.
node - "$WORKTREE/src/app/presentation/page.tsx" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const fileStat = fs.lstatSync(file);
if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
  console.error('[cache-components-spike] FAIL: presentation page must be a regular non-symlink file in scratch worktree');
  process.exit(1);
}
let source = fs.readFileSync(file, 'utf8');
const cookieImport = 'import { cookies } from "next/headers";';
const pageBlock = `export default async function PresentationPage({ searchParams }: PresentationPageProps) {
  const params = await searchParams;
  const presenterRequested = params.presenter === "1";

  if (presenterRequested) {
    const token = (await cookies()).get(ADMIN_PRESENTATION_COOKIE)?.value;
    if (!isAdminPresentationAuthConfigured() || !verifyAdminPresentationSession(token)) {
      redirect("/admin/presentation");
    }
  }

  return <PresentationScreen presenterRequested={presenterRequested} />;
}`;
const suspenseImport = 'import { Suspense } from "react";\n';
const suspensePageBlock = `export default function PresentationPage({ searchParams }: PresentationPageProps) {
  return (
    <Suspense fallback={<main aria-busy="true">プレゼンテーションを準備しています…</main>}>
      <PresentationPageContent searchParams={searchParams} />
    </Suspense>
  );
}

async function PresentationPageContent({ searchParams }: PresentationPageProps) {
  const params = await searchParams;
  const presenterRequested = params.presenter === "1";

  if (presenterRequested) {
    const token = (await cookies()).get(ADMIN_PRESENTATION_COOKIE)?.value;
    if (!isAdminPresentationAuthConfigured() || !verifyAdminPresentationSession(token)) {
      redirect("/admin/presentation");
    }
  }

  return <PresentationScreen presenterRequested={presenterRequested} />;
}`;
if (
  source.split(cookieImport).length !== 2 ||
  source.split(pageBlock).length !== 2 ||
  source.split(suspenseImport).length !== 1
) {
  console.error('[cache-components-spike] FAIL: presentation page does not match the expected request-bound source');
  process.exit(1);
}
source = source.replace(cookieImport, `${suspenseImport}${cookieImport}`).replace(pageBlock, suspensePageBlock);
fs.writeFileSync(file, source);
console.log('[cache-components-spike] Wrapped presentation searchParams/cookie auth child in Suspense in scratch worktree; auth gate preserved');
NODE

# The questions GET route currently reads the database without a request-time
# API. Access Request.url first so prerender bails out before opening the DB.
node - "$WORKTREE/src/app/api/questions/batch/route.ts" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const fileStat = fs.lstatSync(file);
if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
  console.error('[cache-components-spike] FAIL: questions batch route must be a regular non-symlink file in scratch worktree');
  process.exit(1);
}
const source = fs.readFileSync(file, 'utf8');
const handlerHead = 'export const GET = withErrorHandling(async function () {\n  const questions = await getExamQuestions();';
if (source.split(handlerHead).length !== 2) {
  console.error('[cache-components-spike] FAIL: questions batch route does not match the expected handler');
  process.exit(1);
}
const requestBoundHandler = 'export const GET = withErrorHandling(async function (request: Request) {\n  void request.url;\n  const questions = await getExamQuestions();';
fs.writeFileSync(file, source.replace(handlerHead, requestBoundHandler));
console.log('[cache-components-spike] Added Request.url prerender bailout before questions DB read in scratch worktree');
NODE

# Next 16.3 rejects the explicit Node.js runtime segment config when global
# cacheComponents is enabled, although Node.js is the default runtime. Remove
# only that static declaration from API route handlers in the scratch tree.
node - "$WORKTREE/src/app" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const appRoot = process.argv[2];
const declaration = /^[\t ]*export\s+const\s+runtime\s*=\s*(["'])nodejs\1[\t ]*;?[\t ]*(?:\r?\n|$)/gm;
const routeFiles = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collect(entryPath);
    } else if (entry.isFile() && entry.name === 'route.ts') {
      routeFiles.push(entryPath);
    }
  }
}

collect(appRoot);
const expectedFiles = new Set([
  'api/admin/participant-results/route.ts',
  'api/admin/presentation/deck/route.ts',
  'api/admin/presentation/route.ts',
  'api/admin/session/route.ts',
  'api/internal/jev/retry/route.ts',
  'api/participants/results/route.ts',
  'api/participants/session/route.ts',
  'api/presentation/route.ts',
]);
const matchesByFile = new Map();
const allMatchingFiles = new Set();
for (const file of routeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const matches = source.match(declaration) ?? [];
  if (matches.length > 0) {
    const relative = path.relative(appRoot, file).split(path.sep).join('/');
    allMatchingFiles.add(relative);
    matchesByFile.set(file, matches.length);
  }
}
const actual = [...allMatchingFiles].sort();
const expected = [...expectedFiles].sort();
const exactFileSet = actual.length === expected.length && actual.every((file, index) => file === expected[index]);
const exactCounts = [...matchesByFile.values()].every((count) => count === 1);
if (!exactFileSet || !exactCounts || matchesByFile.size !== 8) {
  console.error(`[cache-components-spike] FAIL: expected exactly one runtime="nodejs" declaration in the 8 allowlisted API routes; found ${[...matchesByFile].map(([file, count]) => `${path.relative(appRoot, file)}=${count}`).join(', ') || 'none'}`);
  process.exit(1);
}
const changedFiles = [];
let removedCount = 0;
for (const file of routeFiles) {
  if (!expectedFiles.has(path.relative(appRoot, file).split(path.sep).join('/'))) continue;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    console.error(`[cache-components-spike] FAIL: expected API route is not a regular file: ${path.relative(appRoot, file)}`);
    process.exit(1);
  }
  const source = fs.readFileSync(file, 'utf8');
  const count = matchesByFile.get(file);
  removedCount += count;
  changedFiles.push(path.relative(path.resolve(appRoot, '..', '..'), file));
  fs.writeFileSync(file, source.replace(declaration, ''));
}
console.log(`[cache-components-spike] Removed ${removedCount} static runtime="nodejs" declaration(s) from ${changedFiles.length} API route file(s) in scratch worktree`);
for (const file of changedFiles) console.log(`[cache-components-spike]   ${file}`);
NODE

# Keep all results request-bound reads inside a child suspended from the static
# shell. The existing child validation order and nested protected-query boundary
# are retained verbatim in the disposable copy.
node - "$WORKTREE/src/app/results/page.tsx" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const fileStat = fs.lstatSync(file);
if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
  console.error('[cache-components-spike] FAIL: results page must be a regular non-symlink file in scratch worktree');
  process.exit(1);
}
let source = fs.readFileSync(file, 'utf8');
const suspenseImport = 'import { Suspense } from "react";';
const pageBlock = `export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  let scopeMode: "owner" | "assisted" | null = "owner";
  try {
    const params = await searchParams;
    const requestedScope = params.scope;
    if (requestedScope === "assisted") scopeMode = "assisted";
    else if (requestedScope !== undefined) scopeMode = null;
    const token = (await cookies()).get(PARTICIPANT_COOKIE)?.value;
    const session = verifyParticipantSession(token);
    if (!session || !(await findParticipantById(session.id))) {
      return <ResultsPanel initial={{ state: "unauthenticated" }} scope={scopeMode} />;
    }
    if (scopeMode === null) {
      return <ResultsPanel initial={{ state: "unavailable" }} scope={scopeMode} />;
    }

    const scope = await resolveAnswerScope(
      session.id,
      scopeMode === "assisted" ? "assisted" : null,
    );
    if ("error" in scope) {
      return <ResultsPanel initial={{ state: "unavailable" }} scope={scopeMode} />;
    }

    return (
      <Suspense fallback={<ResultsShell scope={scopeMode} />}>
        <ResultsContent participantId={scope.participantId} scope={scopeMode} />
      </Suspense>
    );
  } catch {
    // Fail closed with neutral content when the server cannot verify the session or visibility.
    return <ResultsPanel initial={{ state: "waiting" }} scope={scopeMode} />;
  }
}`;
const pageHeader = `export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {`;
if (
  source.split(suspenseImport).length !== 2 ||
  source.split(pageBlock).length !== 2 ||
  pageBlock.split(pageHeader).length !== 2
) {
  console.error('[cache-components-spike] FAIL: results page does not match the expected protected source block');
  process.exit(1);
}
const pageBody = pageBlock.replace(
  pageHeader,
  `async function ResultsPageContent({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {`,
);
const suspensePage = `export default function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  return (
    <Suspense fallback={<main aria-busy="true"><p>結果を読み込んでいます。</p></main>}>
      <ResultsPageContent searchParams={searchParams} />
    </Suspense>
  );
}

${pageBody}`;
source = source.replace(pageBlock, suspensePage);
fs.writeFileSync(file, source);
console.log('[cache-components-spike] Moved results session/scope validation under outer Suspense in scratch worktree; protected query remains after validation');
NODE

# `dynamic = "force-dynamic"` is unnecessary under Cache Components. Remove
# only the known declaration from the results page in this scratch worktree.
node - "$WORKTREE/src/app/results/page.tsx" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const fileStat = fs.lstatSync(file);
if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
  console.error('[cache-components-spike] FAIL: results page must be a regular non-symlink file in scratch worktree');
  process.exit(1);
}
const source = fs.readFileSync(file, 'utf8');
const declaration = /^export const dynamic = "force-dynamic";\r?$/gm;
const matches = source.match(declaration) ?? [];
if (matches.length !== 1) {
  console.error(`[cache-components-spike] FAIL: expected exactly one results force-dynamic declaration; found ${matches.length}`);
  process.exit(1);
}
fs.writeFileSync(file, source.replace(declaration, ''));
console.log('[cache-components-spike] Removed src/app/results/page.tsx: export const dynamic = "force-dynamic"; in scratch worktree');
NODE

# The existing unit test imports and asserts the removed segment config. Adapt
# only those two exact artifacts in the scratch copy; preserve its other checks.
node - "$WORKTREE/tests/results/results-page.test.tsx" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const fileStat = fs.lstatSync(file);
if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
  console.error('[cache-components-spike] FAIL: results page test must be a regular non-symlink file in scratch worktree');
  process.exit(1);
}
let source = fs.readFileSync(file, 'utf8');
const importLine = 'import ResultsPage, { dynamic } from "@/app/results/page";';
const assertionLine = '    expect(dynamic).toBe("force-dynamic");';
const importCount = source.split(importLine).length - 1;
const assertionCount = source.split(assertionLine).length - 1;
if (importCount !== 1 || assertionCount !== 1) {
  console.error(`[cache-components-spike] FAIL: expected one results dynamic import and assertion; found import=${importCount}, assertion=${assertionCount}`);
  process.exit(1);
}
source = source.replace(importLine, 'import ResultsPage from "@/app/results/page";');
source = source.replace(assertionLine, '');
fs.writeFileSync(file, source);
console.log('[cache-components-spike] Adapted tests/results/results-page.test.tsx in scratch worktree: removed only dynamic import/assertion');
NODE

node - "$CONFIG" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const baseline = '  cacheComponents: false,\n  distDir: ".next-cache-components-baseline",';
const candidate = '  cacheComponents: true,\n  distDir: ".next-cache-components-candidate",';
if (source.split(baseline).length !== 2) {
  console.error('[cache-components-spike] FAIL: could not safely switch scratch config from baseline to candidate');
  process.exit(1);
}
fs.writeFileSync(file, source.replace(baseline, candidate));
console.log('[cache-components-spike] Enabled cacheComponents only for the candidate build; candidate distDir is isolated');
NODE

echo "[cache-components-spike] Building Cache Components candidate"
echo "[cache-components-spike] Offline guard: next/font/google is disabled in this disposable build copy"
BUILD_LOG="$TEMP_ROOT/candidate-build.log"
if run_logged "$BUILD_LOG" "$WORKTREE" \
  env -i PATH="$PATH" NODE_ENV=production CI=1 NEXT_TELEMETRY_DISABLED=1 \
  "$NODE_MODULES/.bin/next" build --webpack; then
  build_status=0
else
  build_status=$?
fi
cat "$BUILD_LOG"

if [[ "$build_status" != 0 ]]; then
  if grep -Eq 'Route segment config "[^"]+" is not compatible with (`nextConfig\.cacheComponents`|cacheComponents)' "$BUILD_LOG"; then
    echo "[cache-components-spike] RESULT: COMPATIBILITY FAIL (Next rejected a route segment config with cacheComponents; see output above)" >&2
  else
    echo "[cache-components-spike] RESULT: BUILD ERROR / INCONCLUSIVE (no explicit Cache Components incompatibility diagnostic; see Next output above)" >&2
  fi
  exit "$build_status"
fi

CANDIDATE_MEASURE_LOG="$TEMP_ROOT/candidate-measure.log"
CANDIDATE_METRICS="$TEMP_ROOT/candidate-metrics.json"
echo "[cache-components-spike] Measuring synthetic Cache Components candidate with the identical results-page harness"
if run_captured "$CANDIDATE_METRICS" "$CANDIDATE_MEASURE_LOG" "$WORKTREE" \
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" RESULTS_BENCH_SAMPLES=5 \
  node scripts/measure-results-page.mjs; then
  cat "$CANDIDATE_MEASURE_LOG"
else
  candidate_measure_status=$?
  cat "$CANDIDATE_MEASURE_LOG"
  echo "[cache-components-spike] RESULT: INCONCLUSIVE (candidate synthetic measurement failed with status $candidate_measure_status)" >&2
  exit "$candidate_measure_status"
fi

echo "[cache-components-spike] Comparing synthetic baseline/candidate p50 values (exploratory lab data, n=5)"
node - "$BASELINE_METRICS" "$CANDIDATE_METRICS" <<'NODE'
const fs = require('node:fs');
const [baselinePath, candidatePath] = process.argv.slice(2);
let baseline;
let candidate;
try {
  baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
} catch {
  process.stdout.write(`${JSON.stringify({ classification: 'INCONCLUSIVE', reason: 'Could not parse both measurement reports' }, null, 2)}\n`);
  process.exit(0);
}
const expectedGroups = [
  'owner_fresh_context',
  'owner_reload',
  'assisted_fresh_context',
  'assisted_reload',
];
const sameFixture =
  baseline !== null &&
  candidate !== null &&
  typeof baseline === 'object' &&
  typeof candidate === 'object' &&
  baseline.measurement === candidate.measurement &&
  baseline.database === 'disposable_file_backed_sqlite' &&
  candidate.database === 'disposable_file_backed_sqlite' &&
  baseline.fixture === candidate.fixture &&
  baseline.base_url === candidate.base_url;
if (!sameFixture) {
  process.stdout.write(`${JSON.stringify({ classification: 'INCONCLUSIVE', same_seeded_fixture_and_loopback_conditions: false }, null, 2)}\n`);
  process.exit(0);
}
const compareMetric = (baselineValue, candidateValue, complete = true) => {
  if (!sameFixture || !complete || !Number.isFinite(baselineValue) || !Number.isFinite(candidateValue)) {
    return {
      status: 'INCONCLUSIVE',
      baseline_p50: Number.isFinite(baselineValue) ? baselineValue : null,
      candidate_p50: Number.isFinite(candidateValue) ? candidateValue : null,
      delta_percent: null,
    };
  }
  if (baselineValue === 0) {
    return {
      status: 'INCONCLUSIVE',
      baseline_p50: baselineValue,
      candidate_p50: candidateValue,
      delta_percent: null,
    };
  }
  return {
    status: 'COMPARED',
    baseline_p50: baselineValue,
    candidate_p50: candidateValue,
    delta_percent: ((candidateValue - baselineValue) / baselineValue) * 100,
  };
};
const compareClsMetric = (before, after, complete) => {
  const baselineValue = before?.cls_sum_in_observed_window?.p50;
  const candidateValue = after?.cls_sum_in_observed_window?.p50;
  const observationDetails = {
    baseline: {
      sample_count: before?.cls_sum_in_observed_window?.sample_count ?? null,
      observer_supported_count: before?.cls_sum_in_observed_window?.observer_supported_count ?? null,
      observer_unsupported_count: before?.cls_sum_in_observed_window?.observer_unsupported_count ?? null,
      entry_count: before?.cls_sum_in_observed_window?.entry_count ?? null,
      observation_window: 'bounded capture window',
    },
    candidate: {
      sample_count: after?.cls_sum_in_observed_window?.sample_count ?? null,
      observer_supported_count: after?.cls_sum_in_observed_window?.observer_supported_count ?? null,
      observer_unsupported_count: after?.cls_sum_in_observed_window?.observer_unsupported_count ?? null,
      entry_count: after?.cls_sum_in_observed_window?.entry_count ?? null,
      observation_window: 'bounded capture window',
    },
  };
  const clsComplete = complete &&
    before?.cls_sum_in_observed_window?.sample_count === 5 &&
    after?.cls_sum_in_observed_window?.sample_count === 5 &&
    before?.cls_sum_in_observed_window?.observer_supported_count === 5 &&
    after?.cls_sum_in_observed_window?.observer_supported_count === 5 &&
    before?.cls_sum_in_observed_window?.observer_unsupported_count === 0 &&
    after?.cls_sum_in_observed_window?.observer_unsupported_count === 0;
  if (!clsComplete || !Number.isFinite(baselineValue) || !Number.isFinite(candidateValue)) {
    return {
      status: 'INCONCLUSIVE',
      baseline_p50: Number.isFinite(baselineValue) ? baselineValue : null,
      candidate_p50: Number.isFinite(candidateValue) ? candidateValue : null,
      absolute_delta: null,
      delta_percent: null,
      observation_window: 'bounded capture window',
      observation_details: observationDetails,
    };
  }
  return {
    status: 'COMPARED',
    baseline_p50: baselineValue,
    candidate_p50: candidateValue,
    absolute_delta: candidateValue - baselineValue,
    delta_percent: baselineValue === 0 ? null : ((candidateValue - baselineValue) / baselineValue) * 100,
    observation_window: 'bounded capture window',
    observation_details: observationDetails,
  };
};
const nearestRank = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
};
const runRecordsForGroup = (report, groupName) => {
  const scope = groupName.startsWith('owner_') ? 'owner' : 'assisted';
  const labelPattern = groupName.endsWith('_reload') ? /^reload-[1-5]$/ : /^fresh-context-[1-5]$/;
  return (Array.isArray(report?.samples) ? report.samples : []).filter(
    (sample) => sample.scope === scope && labelPattern.test(sample.sample ?? ''),
  );
};
const exactSpikeRunSet = (report, groupName) => {
  const records = runRecordsForGroup(report, groupName);
  const prefix = groupName.endsWith('_reload') ? 'reload-' : 'fresh-context-';
  const labels = new Set(records.map((record) => record.sample));
  return records.length === 5 && labels.size === 5 &&
    Array.from({ length: 5 }, (_, index) => `${prefix}${index + 1}`).every((label) => labels.has(label));
};
const samplesFor = (report, groupName, metricName) => {
  const records = runRecordsForGroup(report, groupName);
  const valueFor = (sample) => {
    if (metricName === 'document_ttfb_proxy_ms') return sample.response_start_ttfb_proxy_ms;
    if (metricName === 'first_contentful_paint_ms') return sample.first_contentful_paint_ms;
    if (metricName === 'first_results_heading_frame_proxy_ms') return sample.first_results_heading_frame_proxy_ms;
    if (metricName === 'lcp_start_time_ms') return sample.lcp_entries?.at(-1)?.startTime_ms;
    if (metricName === 'cls_observed_window') {
      if (sample.layout_shift_observer_supported !== true) return null;
      return (sample.layout_shift_entries ?? []).reduce(
        (sum, entry) => sum + (entry.hadRecentInput ? 0 : entry.value),
        0,
      );
    }
    if (metricName === 'document_body_bytes') return sample.document_body_decoded_bytes;
    if (metricName === 'rsc_body_bytes_per_sample') {
      const requests = sample.rsc_requests ?? [];
      if (!requests.length || requests.some((request) => !Number.isFinite(request.bytes))) return null;
      return requests.reduce((sum, request) => sum + request.bytes, 0);
    }
    return null;
  };
  return records.map(valueFor).filter(Number.isFinite);
};
const withRunSamples = (metric, groupName, metricName) => {
  const baselineSamples = samplesFor(baseline, groupName, metricName);
  const candidateSamples = samplesFor(candidate, groupName, metricName);
  let status = metric.status;
  if (
    status === 'COMPARED' &&
    (baselineSamples.length !== 5 || candidateSamples.length !== 5)
  ) {
    status = 'INCONCLUSIVE';
  }
  const notObservedRsc = metricName === 'rsc_body_bytes_per_sample' && status === 'NOT_OBSERVED';
  const outputBaselineSamples = notObservedRsc ? [] : baselineSamples;
  const outputCandidateSamples = notObservedRsc ? [] : candidateSamples;
  const keepSummaries = status === 'COMPARED';
  return {
    ...metric,
    status,
    baseline_samples: outputBaselineSamples,
    candidate_samples: outputCandidateSamples,
    baseline_sample_count: outputBaselineSamples.length,
    candidate_sample_count: outputCandidateSamples.length,
    delta_percent: keepSummaries ? metric.delta_percent ?? null : null,
    absolute_delta: keepSummaries ? metric.absolute_delta ?? null : null,
    baseline_p50: notObservedRsc || !keepSummaries
      ? null
      : nearestRank(outputBaselineSamples, 0.5),
    candidate_p50: notObservedRsc || !keepSummaries
      ? null
      : nearestRank(outputCandidateSamples, 0.5),
    baseline_p75: notObservedRsc || !keepSummaries
      ? null
      : nearestRank(outputBaselineSamples, 0.75),
    candidate_p75: notObservedRsc || !keepSummaries
      ? null
      : nearestRank(outputCandidateSamples, 0.75),
    ...(metricName === 'rsc_body_bytes_per_sample'
      ? {
          baseline_p50_bytes: keepSummaries ? nearestRank(outputBaselineSamples, 0.5) : null,
          candidate_p50_bytes: keepSummaries ? nearestRank(outputCandidateSamples, 0.5) : null,
        }
      : {}),
  };
};
const output = {
  classification: sameFixture ? 'EXPLORATORY_LAB_COMPARISON' : 'INCONCLUSIVE',
  samples_per_group: 5,
  run_order_baseline_then_candidate: true,
  same_seeded_fixture_and_loopback_conditions: sameFixture,
  database_file_recreated_for_each_run: true,
  excluded_metrics: ['visibility_refresh_bytes', 'visibility_refresh_ttfb_proxy_ms', 'rsc_body_bytes_per_sample when NOT_OBSERVED'],
  excluded_metrics_reason: 'Visibility refresh is not compared; RSC has no comparative status when either side emitted no _rsc response for a group. Document navigation bytes are compared separately.',
  sample_summary_method: 'baseline_samples and candidate_samples contain finite numeric observations in capture order only; p50 and p75 use nearest-rank (sorted values at ceil(p*n)-1). Missing values are omitted, not imputed.',
  rsc_comparison_policy: 'If either report has no observed _rsc response for a group, that group is NOT_OBSERVED and excluded; any observed-but-incomplete body-byte collection makes that group INCONCLUSIVE. Missing RSC requests are not counted as zero-byte responses.',
  first_results_heading_frame_proxy_definition: 'Navigation-relative performance.now() on the second nested requestAnimationFrame after #answer-details-heading is visible (non-empty client rects and computed display/visibility); proxy, not paint timestamp.',
  groups: {},
};
for (const groupName of expectedGroups) {
  const before = baseline.groups?.[groupName];
  const after = candidate.groups?.[groupName];
  const groupComplete = before?.sample_count === 5 && after?.sample_count === 5 &&
    exactSpikeRunSet(baseline, groupName) && exactSpikeRunSet(candidate, groupName);
  const metric = (path, observedCount = () => true) => {
    const get = (root) => path(root);
    const b = before && get(before);
    const c = after && get(after);
    const bCountOk = before && observedCount(before);
    const cCountOk = after && observedCount(after);
    return compareMetric(b, c, groupComplete && bCountOk && cCountOk);
  };
  const metrics = {
    document_ttfb_proxy_ms: metric((group) => group.response_start_ttfb_proxy_ms?.p50_ms, (group) => group.response_start_ttfb_proxy_observed_sample_count === 5),
    first_contentful_paint_ms: metric((group) => group.first_contentful_paint_ms?.p50_ms, (group) => group.first_contentful_paint_ms?.observed_sample_count === 5),
    first_results_heading_frame_proxy_ms: metric((group) => group.first_results_heading_frame_proxy_ms?.p50_ms, (group) => group.first_results_heading_frame_proxy_ms?.observed_sample_count === 5),
    lcp_start_time_ms: metric((group) => group.lcp_start_time_ms?.p50_ms, (group) => group.lcp_start_time_ms?.observed_sample_count === 5 && group.lcp_start_time_ms?.timed_out_count === 0),
    cls_observed_window: compareClsMetric(before, after, groupComplete),
    document_body_bytes: metric((group) => group.document_body_decoded_bytes?.p50_bytes, (group) => group.document_body_decoded_observed_sample_count === 5),
    rsc_body_bytes_per_sample: (() => {
      const beforeStatus = before?.rsc?.status;
      const afterStatus = after?.rsc?.status;
      const diagnostic = (group) => ({
        status: group?.rsc?.status ?? 'MISSING',
        request_count: group?.rsc?.request_count ?? null,
        body_bytes_read_count: group?.rsc?.body_bytes_read_count ?? null,
        missing_body_bytes_count: group?.rsc?.missing_body_bytes_count ?? null,
        samples_with_observed_body_bytes: group?.rsc?.samples_with_observed_body_bytes ?? null,
        samples_without_observed_body_bytes: group?.rsc?.samples_without_observed_body_bytes ?? null,
      });
      const diagnostics = { baseline: diagnostic(before), candidate: diagnostic(after) };
      if (beforeStatus === 'INCONCLUSIVE' || afterStatus === 'INCONCLUSIVE') {
        return {
          status: 'INCONCLUSIVE',
          baseline_status: beforeStatus ?? 'MISSING',
          candidate_status: afterStatus ?? 'MISSING',
          reason: 'An observed _rsc response has incomplete or failed body-byte capture.',
          diagnostics,
        };
      }
      if (beforeStatus === 'NOT_OBSERVED' || afterStatus === 'NOT_OBSERVED') {
        return {
          status: 'NOT_OBSERVED',
          baseline_status: beforeStatus ?? 'MISSING',
          candidate_status: afterStatus ?? 'MISSING',
          baseline_p50_bytes: before?.rsc?.per_sample_body_bytes?.p50_bytes ?? null,
          candidate_p50_bytes: after?.rsc?.per_sample_body_bytes?.p50_bytes ?? null,
          reason: 'At least one run emitted no _rsc response in this group; absence is not a zero-byte measurement.',
          diagnostics,
        };
      }
      return {
        ...metric(
        (group) => group.rsc?.per_sample_body_bytes?.p50_bytes,
        (group) => group.rsc?.status === 'OBSERVED_COMPLETE' && group.rsc?.samples_with_observed_body_bytes === 5 && group.rsc?.missing_body_bytes_count === 0,
        ),
        diagnostics,
      };
    })(),
  };
  if (!before || !after) {
    for (const value of Object.values(metrics)) value.status = 'INCONCLUSIVE';
  }
  for (const [metricName, metricValue] of Object.entries(metrics)) {
    metrics[metricName] = withRunSamples(metricValue, groupName, metricName);
  }
  output.groups[groupName] = { sample_count_match: groupComplete, metrics };
}
const everyMetricCompared = Object.values(output.groups).every((group) =>
  Object.values(group.metrics).every((metric) => metric.status === 'COMPARED' || metric.status === 'NOT_OBSERVED'),
);
const incompleteObservedRsc = Object.values(output.groups).some(
  (group) => group.metrics.rsc_body_bytes_per_sample.status === 'INCONCLUSIVE',
);
if (
  !sameFixture ||
  !everyMetricCompared ||
  incompleteObservedRsc ||
  expectedGroups.some((name) => !baseline.groups?.[name] || !candidate.groups?.[name])
) {
  output.classification = 'INCONCLUSIVE';
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
NODE

echo "[cache-components-spike] Running authenticated synthetic route Activity runtime probe"
ACTIVITY_LOG="$TEMP_ROOT/activity-probe.log"
if run_logged "$ACTIVITY_LOG" "$WORKTREE" \
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
  node scripts/measure-results-page.mjs --activity-probe; then
  cat "$ACTIVITY_LOG"
  echo "[cache-components-spike] ACTIVITY RUNTIME: PASS (authenticated synthetic /results state/effect and unsent owner draft retention exercised)"
else
  runtime_status=$?
  cat "$ACTIVITY_LOG"
  echo "[cache-components-spike] ACTIVITY RUNTIME: FAIL / INCONCLUSIVE (inspect probe output; no compatibility conclusion)" >&2
  echo "[cache-components-spike] RESULT: PARTIAL" >&2
  exit "$runtime_status"
fi

echo "[cache-components-spike] RESULT: PARTIAL"
echo "[cache-components-spike] Build, /results route Activity state/effect, and unsent owner draft retention passed with synthetic data."
echo "[cache-components-spike] Baseline-first metrics above are exploratory n=5 loopback lab measurements; cache/process warmness is not counterbalanced, so these are not field budgets or acceptance evidence."
echo "[cache-components-spike] Overall adoption remains partial: submitted-answer lifecycle, answer POST behavior beyond asserting zero in this probe, production field budgets, and full plan acceptance are not covered."
