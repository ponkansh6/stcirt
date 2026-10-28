# Plan 100 route baseline

Captured 2026-10-28 from the current working tree. This is a synthetic local baseline, not a production-user or remote-network measurement. The durable record is paired with `shared_plan/100-SIMPLIFICATION_AND_PAYLOAD_REFACTORING_PLAN.md`; raw JSON outputs were written under `/tmp/stcirt-plan100-routes-final.json`, `/tmp/stcirt-plan100-presentation.json`, `/tmp/stcirt-plan100-routes-operations.json` (plus `-2` and `-3`), `/tmp/stcirt-plan100-presentation-visual-success.json` (plus `-verification` and `-third`), `/tmp/stcirt-plan100-candidate-1.json` through `-3.json`, and `/tmp/stcirt-plan100-presentation-burst-final.json`. These raw outputs are not repository artifacts.

## Webpack client graph

`ANALYZE=1 pnpm build` completed with Next.js 16.4.2 Webpack. The first attempts failed because `next/font/google` could not fetch Geist in the restricted network; the successful build used the explicitly approved network-enabled build command. Analyzer HTML is generated under `.next/analyze/` and is build output, not a durable repository artifact.

The client manifests and analyzer report show these route chains:

| Route           | Client chunks                                                     | Parsed / gzip estimate                                           |
| --------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `/answer`       | shared layout, `966`, `873`, answer entry `577`                   | answer entry 75.8 / 20.6 KB; Zod-containing `577` 84.9 / 24.2 KB |
| `/results`      | shared layout, `873`, results entry                               | results entry 17.4 / 6.0 KB                                      |
| `/presentation` | shared layout, `966`, presentation entry, presentation-only `516` | presentation entry 36.7 / 11.0 KB; `516` 135.3 / 45.0 KB         |

Chunk `873` (Next Link/router, parsed 6.9 KB / gzip estimate 3.1 KB) is shared by answer and results. Chunk `966` (React compiler runtime and Next core, parsed 15.7 KB / gzip estimate 5.8 KB) is shared by answer and presentation. Chunk `577` contains Zod v4 and is in the answer client manifest. `quiz-runner.tsx` and `use-quiz-session.ts` import API functions and `ApiError` from the runtime client module; that module performs Zod parsing. This is an actual route dependency, and removing validation is outside the plan. The presentation-only `516` contains framer-motion (parsed 135.3 KB / gzip estimate 45.0 KB); prior Plan 100 evidence says only about 1.98 KB gzip is grouped AnimatePresence code and the already evaluated Motion/LazyMotion delta is 310 B, so this was not re-proposed. Results has no route-specific CSS entry in its manifest; all three use shared layout CSS, with additional CSS for answer and presentation.

Analyzer parsed and gzip-estimated sizes describe bundles. They are not HTTP transfer bytes, wire bytes, or LCP. Initial graph inspection did not select a candidate: the answer dependency includes runtime API validation and the measured small motion alternative was already rejected by the plan. A deferred API-client candidate was later measured and rejected; see the candidate comparison below.

## Route navigation measurements

The route probe used one production Webpack build, headless Playwright Chromium, Linux, 1365×768 viewport, a disposable SQLite fixture, and `127.0.0.1:3001`. Each route had three fresh browser-context samples and three same-context new-page samples. The latter reused one browser context and opened a new page; it was not a reload of the same page. Playwright route interception was disabled to preserve Chromium cache. Network safety used a non-forwarding loopback proxy sink, loopback-only bypass, fail-closed DNS for non-loopback hostnames, and a fail-fast external-origin check. The `/presentation` route was public presenter mode. Results and presentation data were minimal synthetic fixtures; answer measured authenticated route assets, not an exam interaction.

Resource Timing values below are per route and identical across the three repetitions. `transfer` is browser-observed transfer size (not remote wire framing); `encoded` and `decoded` are resource body sizes. These three measures are distinct. Revisit transfer size of 0 B with nonzero encoded size is consistent with browser-cache reuse.

| Route / cache condition               | JS transfer / encoded / decoded | CSS transfer / encoded / decoded | Font transfer / encoded / decoded | FCP samples (ms) | Last bounded LCP entry (ms) |
| ------------------------------------- | ------------------------------: | -------------------------------: | --------------------------------: | ---------------- | --------------------------- |
| `/answer` fresh context               |   190,612 / 187,912 / 634,538 B |         7,794 / 7,194 / 30,984 B |        29,588 / 29,288 / 29,288 B | 104, 76, 100     | 408, 256, 264               |
| `/answer` same-context new page       |         0 / 187,912 / 634,538 B |             0 / 7,194 / 30,984 B |             0 / 29,288 / 29,288 B | 52, 52, 68       | 236, 228, 244               |
| `/results` fresh context              |   146,445 / 144,045 / 476,888 B |         7,192 / 6,892 / 30,682 B |        29,588 / 29,288 / 29,288 B | 148, 96, 96      | 148, 96, 96                 |
| `/results` same-context new page      |         0 / 144,045 / 476,888 B |             0 / 6,892 / 30,682 B |             0 / 29,288 / 29,288 B | 76, 76, 80       | 76, 76, 80                  |
| `/presentation` fresh context         |   198,457 / 196,057 / 638,945 B |       13,531 / 12,931 / 60,500 B |        29,588 / 29,288 / 29,288 B | 188, 240, 176    | no LCP entry                |
| `/presentation` same-context new page |         0 / 196,057 / 638,945 B |            0 / 12,931 / 60,500 B |             0 / 29,288 / 29,288 B | 144, 140, 140    | no LCP entry                |

Document decoded bodies were 7,271 B (`/answer`), 7,068 B (`/results`), and 8,518 B (`/presentation`). The probe observes LCP entries only within a fixed 750 ms window after DOMContentLoaded; the last entry is not guaranteed terminal LCP. It is a local synthetic observation, not production LCP. Server, OS, and Next caches could remain warm. The original navigation samples did not include interactions; the supplemental probes below cover one synthetic answer flow and one presentation visual flow.

## Supplemental interaction and visual probes

A supplemental `/answer` `synthetic_login_load_answer_submit` interaction ran three times as three independent single-sample runs. Its JSON records per-scenario sample count, not an overall run-status field; all three report one sample and completed with eight API requests returning HTTP 200. Each used Playwright fulfilled synthetic API responses, not the local API/database. Login to first-question-ready was 103.5, 105.9, and 107.2 ms (range 103.5–107.2 ms); submit to completion-ready was 77.0, 83.3, and 91.3 ms (range 77.0–91.3 ms). The API requests were session GET/POST, latest answers GET, question batch GET, answer batch POST, assisted participant GET, results GET, and answer batch GET by submission ID. Across runs, API route-handler elapsed time ranges were: session GET 0.037–0.044 ms; session POST 0.019–0.029 ms; latest answers GET 0.017–0.023 ms; question batch GET 0.022–0.025 ms; answer batch POST 0.311–0.336 ms; assisted participant GET 0.024–0.036 ms; results GET 0.015–0.018 ms; final answer batch GET 0.056–0.087 ms. These elapsed values are Playwright route-handler time, not network or DB latency.

After the initial document, each run observed four API resource entries with transfer sizes 368, 358, 319, and 324 B and encoded body sizes 68, 58, 19, and 24 B respectively. The combined interval covers login, question load, answer interaction, and completion; it does not isolate per-action resource use. These three individual runs are only three samples, with synthetic responses. They do not measure remote transfer, terminal LCP, image decode, or production traffic.

A real-route presentation visual probe ran three times as three independent single-sample runs against isolated local SQLite, Next.js 16.4.2, Node 24.22.1, headless Chromium 151.0.7922.34, 1280×720, DPR 1, and default browser motion preference (`prefers-reduced-motion` was not overridden). Each advanced a final-question fixture through synthetic rank-2 to rank-1. In every run, two queried `HTMLImageElement`s decoded; remaining `decode()` wait after the first-place region became visible was 0.4, 1.0, and 0.5 ms (range 0.4–1.0 ms). This excludes total request/load time. A one-time Web Animations API snapshot found eight finite main-thread effects in each run; remaining `finished` promise wait after image decode was 1,231.3, 1,209.6, and 1,222.8 ms (range 1,209.6–1,231.3 ms). Effects created later, pseudo-elements, canvas, and CSS effects outside that snapshot are excluded, so this is not full animation completion time.

After the visual wait, the next synthetic keyboard action reached DOM mutation plus two animation frames in 16.9, 21.1, and 22.0 ms (range 16.9–22.0 ms); its POST took 17.4, 21.5, and 22.3 ms (range 17.4–22.3 ms), all HTTP 200. Each is a separate single local sample. Cold deck navigation took 556.6, 613.5, and 557.9 ms (range 556.6–613.5 ms) to DOM plus two frames; the corresponding GET waits were 9, 20, and 10 ms. These three runs still do not establish a reliable distribution.

All three visual-only runs have `run.status: partial` because they intentionally skip the separate sanity and mock-coverage scenarios; that status does not indicate failure of their visual-only scenario. The earlier 30-sample real-route operation run remains independently `partial`: its five primary operation types each passed 30/30, but the burst sanity scenario timed out at state synchronization after five input IDs and POSTs were observed. Do not combine these three visual samples with the 30-sample distribution or treat the burst as passed. DOM change plus two animation frames is a paint proxy, not a guarantee of completed paint or user-perceived latency.

## Presentation operation probe

`PRESENTATION_BENCH_MODE=real PRESENTATION_BENCH_SAMPLES=30 node scripts/measure-presentation-latency.mjs` used a script-managed `next start` bound to loopback and isolated temporary SQLite through real local routes. Environment: Node 24.22.1, Linux x64, headless Chromium 151.0.7922.34, 1280×720, DPR 1. Browser cache was not explicitly cleared; primary operations were warm. Each operation below had 30/30 successful samples and zero primary failures. Values are p50 / p95 milliseconds.

| Operation         | Input to DOM change + 2 animation frames | POST wait |
| ----------------- | ---------------------------------------: | --------: |
| keyboard advance  |                              26.6 / 37.5 |   14 / 31 |
| keyboard previous |                              28.1 / 46.7 |   17 / 29 |
| click advance     |                              26.9 / 32.4 |   12 / 25 |
| swipe advance     |                            120.3 / 125.0 |   37 / 89 |
| swipe previous    |                            105.5 / 118.4 |   34 / 76 |

These local operation timings measure DOM change through two animation frames and route request response. Two animation frames do not guarantee paint completion, animation completion, or image readiness. This original 30-sample run recorded one cold-deck navigation sample (522.9 ms to DOM plus two animation frames; GET 12 ms); the three supplemental visual runs below add three more individual navigation samples. The original run status is `partial`: a burst sanity scenario timed out while verifying UI/DB state synchronization after all five inputs and POSTs were observed. Do not interpret the burst check as passed.

## P1 implementation and audit

The assisted draft snapshot writer was consolidated into the existing private `persistAssistedDraft` helper. `select` and `setFreeResponse` pass the changed selection/free-response value explicitly, with the other current value supplied from its ref. The update/count/write/phase ordering, eligibility gates, snapshot metadata, synchronous sessionStorage failure handling, and `saveAnswers` pre-submit write remain intact. The first implementation introduced a duplicate helper name; the production build caught it, and the helper was integrated with the existing submit-time writer. Independent review confirmed the submit-time call remains in the same synchronous guarded position.

`pnpm exec vitest run tests/app/answer/use-quiz-session-state.test.tsx` passed: 135 tests. `pnpm lint:fast`, `pnpm format:check`, `pnpm type-check`, and `bash scripts/check-spec-refs.sh` passed after formatting. No spec contract changed.

## Burst sanity recheck

The original 30-sample run's burst sanity check timed out because its checker expected `question` at index 2. Five advances from the real fixture's initial `question` at index 0 actually end at `answer` for question index 2 (the third question's explanation). The announcement parser misclassified “第3問の解説” as a question state. The product state had converged; the check's expected state was wrong.

A separate real-route burst-only run then measured successfully. All five synthetic input IDs (0–4) were observed in order; both POSTs returned successfully, and the latest POST matched input ID 4. The browser's local target and the database, controls, projection, and deck all agreed on `answer`, question index 2. The state synchronization assertion passed. The run's overall status remains partial because burst-only mode skips other sanity and mock-coverage scenarios; the burst scenario itself was measured. This synthetic keyboard burst uses isolated local SQLite and does not establish physical-keyboard or production behavior.

## Candidate comparison: deferred answer API client

To test whether the answer route could defer its Zod-backed API client, a temporary candidate moved `ApiError` to a shared module and changed hook API calls to load `client.ts` dynamically. Zod validation and the `ApiError` class identity were retained. The same `ANALYZE=1 pnpm build` Webpack production build and the same three-run browser probe were used before and after. The candidate is rejected and has been removed from the working tree.

| Measure                                            |                              Baseline (3 runs) |             Deferred-client candidate (3 runs) | Readout                                         |
| -------------------------------------------------- | ---------------------------------------------: | ---------------------------------------------: | ----------------------------------------------- |
| `/answer` JS transfer per fresh-context navigation |                                 190,612 B each |                                 191,626 B each | +1,014 B in the measured navigation window      |
| `/answer` JS encoded body total                    |                                 187,912 B each |                                 188,626 B each | +714 B                                          |
| `/answer` script resource count                    |                                         9 each |                                        10 each | Candidate adds a script request                 |
| Fresh-context FCP samples                          |     104, 104, 104; 104, 76, 104; 96, 76, 76 ms |     100, 76, 104; 104, 92, 68; 108, 72, 100 ms | Ranges overlap; no consistent improvement       |
| Same-context new-page FCP samples                  |          56, 68, 56; 52, 52, 56; 52, 72, 56 ms |          52, 48, 64; 56, 52, 52; 48, 52, 52 ms | Small, inconsistent differences                 |
| Bounded final LCP entries, fresh-context samples   | 412, 264, 284; 396, 240, 264; 396, 256, 260 ms | 428, 252, 284; 408, 324, 252; 412, 252, 276 ms | Bounded observations; no consistent improvement |
| Synthetic login to first question                  |                         103.5, 105.9, 107.2 ms |                         109.0, 103.9, 103.1 ms | No reliable improvement                         |
| Synthetic submit to completion                     |                            77.0, 83.3, 91.3 ms |                           80.9, 88.0, 106.6 ms | Candidate slower in two runs                    |

Analyzer attribution moved the API implementation into an async chunk, but the browser probe still observed that code during the `/answer` navigation window, and the Zod chunk remained. The measured JavaScript bytes therefore increased rather than decreased. The initial FCP and bounded-LCP samples overlap substantially; these small local samples do not establish a timing benefit. Submit-to-completion had two slower candidate runs. The candidate added an asynchronous module boundary and its first-use loading path without reducing measured delivery, so it fails the plan's adoption criteria. It was reverted, including its temporary `ApiError` extraction and test mock changes. Runtime validation and API error identity remain as before.

P2 now includes the candidate before/after experiment and its rejection. The remaining limitation is confidence: navigation has three samples per cache condition, while answer interaction is three separate one-sample synthetic runs and presentation visual behavior is three separate one-sample local runs. Cold-deck samples are also few and variable. These results do not support production-user or remote-network performance claims.
