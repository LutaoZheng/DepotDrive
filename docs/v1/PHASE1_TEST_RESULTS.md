# DepotDrive V1.0 Phase 1 Test Results

Execution date: 2026-09-26. Results below are from commands actually run in the local workspace; they are not inferred.

## Final results

| Command | Exit | Result |
|---|---:|---|
| `npm test` | 0 | 42 passed, 0 failed, 0 skipped |
| `npm run typecheck` | 0 | API, Storage Node, Web, Shared passed |
| `npm run build` | 0 | All four workspaces built; Vite production build passed |
| `docker compose config --quiet` | 0 | Production Compose valid |
| `docker compose -f docker-compose.test.yml config --quiet` | 0 | Test Compose valid |
| `docker compose up -d --build --wait` | 0 | Web, API, PostgreSQL, Storage A and Storage B started |
| `node scripts/failure-demo.mjs` | 0 | 100 MiB and all requested failure transitions passed |

## Unified test breakdown

`npm test` created `depot_drive_test`, applied all four migrations, ran tests, and cleaned the test topology.

### Unit tests

| Workspace | Files | Tests | Failed | Skipped |
|---|---:|---:|---:|---:|
| API | 5 | 15 | 0 | 0 |
| Web | 4 | 18 | 0 | 0 |
| Storage Node | 1 | 2 | 0 | 0 |
| **Unit total** | **10** | **35** | **0** | **0** |

### Real integration tests

`apps/api/tests/integration.test.ts`: 7 passed, 0 failed, 0 skipped, approximately 5.25 seconds test time.

Verified scenarios:

1. Real PostgreSQL registration, login, ownership and upload-session isolation.
2. Two HEALTHY replicas through two HTTP nodes, including physical HEAD size/SHA-256.
3. Out-of-order resumable chunks and duplicate finalize without duplicate metadata.
4. Durable replica deletion and physical object removal.
5. Actual Docker stop/start fallback, both-down 503, and recovery.
6. Injected first-node-success/second-node-failure truth, followed by RUNNING-operation restart reconciliation.
7. Persistent node `UNAVAILABLE → HEALTHY` heartbeat transitions.

The fault tests use Docker containers, not mocked `StorageNode` instances. The test-only node fault endpoint is enabled only in the isolated test Compose.

## Migration result

Fresh test PostgreSQL applied:

```text
20260802000000_init
20260802150000_chunked_uploads
20260803100000_distributed_storage
20260926000000_phase1_reliability
All migrations have been successfully applied.
```

The existing development volume also applied `20260926000000_phase1_reliability` successfully before the full stack started.

## Full Compose evidence

`docker compose ps` showed five running services:

```text
depotdrive-web-1
depotdrive-api-1
depotdrive-postgres-1          healthy
depotdrive-storage-node-a-1   healthy
depotdrive-storage-node-b-1   healthy
```

API startup reported four migrations and `Reconciled incomplete storage files` before listening.

## Failures found and fixed during implementation

- The first test-container run failed healthchecks because BusyBox `wget` resolved `localhost` incompatibly with the listener. Healthchecks now use `127.0.0.1`.
- The next healthcheck returned 401 because the header used single quotes, preventing environment expansion. It now uses a double-quoted Authorization header.
- The first demo attempt hit `ECONNRESET` because it began immediately after API container recreation. The demo now waits for `/health` before registration.

All three failures were fixed and the complete commands rerun successfully. No assertions were removed or weakened.

## Test environment lifecycle

`scripts/test-all.sh` uses `set -euo pipefail` and an EXIT trap. It always invokes `docker compose down --volumes --remove-orphans` for the `depot-drive-test` project. Test PostgreSQL is distinct from development PostgreSQL by database, credentials, port, project name, and lifecycle.

## Remaining untested areas

- Automatic repair and corruption scrub are Phase 2 and do not exist.
- Stream failure after partial response delivery is documented but not transparently recoverable.
- Multi-coordinator races are outside the single-coordinator Phase 1 design.
- Browser DOM/E2E coverage remains limited; the 100 MiB demo exercises the same public chunk API with a Node client rather than browser automation.
