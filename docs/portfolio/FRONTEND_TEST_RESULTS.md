# Final Frontend and System Test Results

Verified on September 26, 2026 on macOS with Docker Desktop, Node.js and installed Google Chrome.

| Command | Result | Evidence |
|---|---:|---|
| `npm run typecheck` | PASS | All workspaces exited 0. |
| `npm run build` | PASS | API, Storage Node, Shared and Web built; Vite transformed 157 modules. |
| `npm test` | PASS | 55 passed, 0 failed, 0 skipped. |
| `node scripts/phase2-demo.mjs` | PASS | Two 100 MiB workflows completed with verified SHA-256. |

## Test accounting

- API unit: 15 passed.
- Web unit: 19 passed.
- Storage Node unit/integration: 4 passed.
- PostgreSQL + real Storage Node integration/fault injection: 15 passed.
- Playwright full-Compose browser E2E: 2 passed.
- Total: **55 passed, 0 failed, 0 skipped**.

The 15 integration tests include real registration/login/cross-user isolation, admin monitoring authorization and CSRF, active-session limiting, two-node publish, idempotent finalize/delete, stopped-node fallback, complete outage 503, partial replication reconciliation, corrupt/missing repair, repair restart recovery, both replicas corrupt, 100 MiB API-restart resume, duplicate resume, garbage collection, and heartbeat transitions.

## Browser E2E evidence

`e2e/portfolio.spec.ts` runs against a disposable Compose project with PostgreSQL, API, Web, Node A and Node B. It does not mock the monitoring API.

1. A normal user registers, uploads, opens real SHA-256 metadata, downloads and hash-checks bytes, deletes, signs out and signs back in; admin navigation is absent.
2. An admin uploads a real 100 MiB file, pauses mid-transfer, refreshes, restarts the API, reselects the file and proves the emitted chunk requests exactly equal the server-reported missing set. It then verifies two DB replicas, stops A and downloads from B, stops B and observes 503 `FILE_UNAVAILABLE`, restores nodes, stops the API and observes `DISCONNECTED`, flips one byte in A, runs scrub, sees persisted `REPLICA_CORRUPT` and `REPLICA_RESTORED`, and verifies the downloaded hash.

The second scenario passed in 39.2 seconds in the final unified run. Browser screenshots are saved in `docs/portfolio/screenshots/` and were captured from that real run.

## Phase 2 demo evidence

The deterministic 100 MiB SHA-256 was `412f60e4a630f1d60653186ad3d80f2a04e0e1ff779c21f46bf176e304c5a260`. The script observed:

- two HEALTHY replicas;
- Node A `CORRUPT`, correct 104,857,600-byte fallback, then two HEALTHY replicas after repair;
- interrupted upload retained indexes 0–6 across an API restart;
- resume sent only 7–12 and produced the same final SHA-256.

## Environment notes

Infrastructure absence is a hard failure; integration/E2E tests never silently skip. The disposable test stacks and their volumes were removed automatically. The standard demo stack was stopped after verification while its named data volumes were retained.
