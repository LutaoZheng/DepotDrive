# Phase 2 Test Results

Date: 2026-09-26 (America/Los_Angeles)

## Final quality gates

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | API, Storage Node, Web, and Shared passed |
| `npm run build` | 0 | All TypeScript builds and Vite production build passed |
| `npm test` | 0 | 51 passed, 0 failed, 0 skipped |
| `docker compose up -d --build --wait` | 0 | postgres, API, Web, Storage A/B healthy |
| `node scripts/phase2-demo.mjs` | 0 | Corruption, fallback, repair, API restart resume passed |

Test count:

- API unit: 15 passed
- Web unit: 19 passed
- Storage Node unit: 4 passed
- Real PostgreSQL/Storage Node integration: 13 passed
- Total: 51 passed, 0 failed, 0 skipped

`npm test` created a disposable PostgreSQL 16 database, applied all five committed migrations, built two Storage Node images, and ran container stop/start and fault injection tests. The script then removed test containers, volumes, and network.

## Phase 2 fault coverage

- Corrupted primary becomes `CORRUPT`; verified backup content is returned.
- Automatic repair restores the corrupted target and both replicas become `HEALTHY`.
- Physically missing object becomes `MISSING` through scrub and is restored.
- `RUNNING` repair survives a reconstructed Coordinator and completes without a third replica row.
- Two corrupted replicas return 503 `FILE_UNAVAILABLE`; metadata remains.
- 100 MiB session retains 7 of 13 chunks across API restart and uploads only indexes 7–12.
- Concurrent upload of the same missing chunk converges on one filesystem object and one row.
- Expired abandoned chunks and session metadata are removed without deleting completed files.

## Failed intermediate runs

The first expanded `npm test` run had 4 failures because the test helper attached JSON content type to bodyless corruption/delete requests; Fastify correctly rejected the empty JSON with 400. The helper was fixed and the unchanged assertions passed.

The first full demo run verified two replicas and correct fallback, but the script checked `CORRUPT` only after the download completed. The three-second repair worker had already restored it to `HEALTHY`, so the observer failed. The demo was changed to observe PostgreSQL concurrently during the download; the next full run captured `CORRUPT` and passed. No production assertion was weakened.
