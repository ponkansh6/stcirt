# Motion exit animation bundle evidence

Measured 2026-10-23 for shared plan 93. The baseline revision was `origin/main` (`8e9a26698645a5fb88d6c1dc6444aa626d3a055a`); the feature/security revision was `999d32ea9ed0da1c4f3dc85ff446eabf8a3b25f9`.

## Method

Environment: Node 24.22.1, pnpm 11.9.0, Next 16.4.2, Motion 14.2.0. Each variant was built with production `pnpm build --webpack`, served on `127.0.0.1:3001`, then captured in a fresh Chromium context at `/presentation`. The capture sums unique `/_next/static/*.js` requests observed through 1200 ms after `load`, without presenter interaction. Raw size is response body bytes. Gzip size is derived per response using Node `zlib.gzipSync` at level 9 and summed; it is not wire transfer size.

The baseline substitutes the three presentation source files from `origin/main` while retaining the current dependencies and Next version. Motion was built from feature/security commit `999d32e` plus the uncommitted exit-reveal source fix present at measurement time: `data-exiting` on the presentation wrapper and paused answer, supplement, and rank reveal CSS. LazyMotion is a temporary equivalent adaptation using `LazyMotion + m + domAnimation`; it is not retained in the product.

## Results

| Variant                |       Raw bytes | Derived gzip bytes | Change vs baseline (raw) | Change vs baseline (gzip) |
| ---------------------- | --------------: | -----------------: | -----------------------: | ------------------------: |
| Baseline               |         500,145 |            149,362 |                        — |                         — |
| Motion                 |         638,267 |            195,181 |       +138,122 (+27.62%) |         +45,819 (+30.68%) |
| LazyMotion (temporary) |         633,809 |            194,871 |       +133,664 (+26.73%) |         +45,509 (+30.47%) |
| LazyMotion vs Motion   | −4,458 (−0.70%) |      −310 (−0.16%) |                        — |                         — |

## Captured JavaScript chunks

Paths and raw response body bytes for each variant:

### Baseline

| Chunk path                                                       | Raw bytes |
| ---------------------------------------------------------------- | --------: |
| `/_next/static/chunks/209b6cdd-672f1a3bbb484790.js`              |   203,720 |
| `/_next/static/chunks/482-20eca440d3e3c473.js`                   |   242,587 |
| `/_next/static/chunks/966-56ad957ba665a046.js`                   |    15,659 |
| `/_next/static/chunks/app/layout-47ba1101912f407e.js`            |     1,143 |
| `/_next/static/chunks/app/presentation/page-c3e9c1114cec0675.js` |    33,168 |
| `/_next/static/chunks/main-app-ae1d45b6c2121c19.js`              |       512 |
| `/_next/static/chunks/webpack-614a4b102901c588.js`               |     3,356 |

### Motion

| Chunk path                                                       | Raw bytes |
| ---------------------------------------------------------------- | --------: |
| `/_next/static/chunks/209b6cdd-672f1a3bbb484790.js`              |   203,720 |
| `/_next/static/chunks/482-20eca440d3e3c473.js`                   |   242,587 |
| `/_next/static/chunks/513-0c5934c810e8da3d.js`                   |   150,832 |
| `/_next/static/chunks/app/layout-47ba1101912f407e.js`            |     1,143 |
| `/_next/static/chunks/app/presentation/page-d3f28f4be8252112.js` |    36,117 |
| `/_next/static/chunks/main-app-ae1d45b6c2121c19.js`              |       512 |
| `/_next/static/chunks/webpack-614a4b102901c588.js`               |     3,356 |

### LazyMotion (temporary)

| Chunk path                                                       | Raw bytes |
| ---------------------------------------------------------------- | --------: |
| `/_next/static/chunks/209b6cdd-672f1a3bbb484790.js`              |   203,720 |
| `/_next/static/chunks/482-20eca440d3e3c473.js`                   |   242,587 |
| `/_next/static/chunks/836-3cb15b63fd25e9d4.js`                   |   146,302 |
| `/_next/static/chunks/app/layout-47ba1101912f407e.js`            |     1,143 |
| `/_next/static/chunks/app/presentation/page-6529f449cd5d9165.js` |    36,189 |
| `/_next/static/chunks/main-app-ae1d45b6c2121c19.js`              |       512 |
| `/_next/static/chunks/webpack-614a4b102901c588.js`               |     3,356 |

## Decision

Retain normal Motion. The temporary LazyMotion adaptation saves only 310 derived gzip bytes (0.16%) over Motion, which does not justify its additional API and wrapper complexity.
