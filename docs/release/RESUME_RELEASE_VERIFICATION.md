# Resume Release Verification

Audit date: 2026-09-27. Every claim below was checked against current source and the final 55-test run plus the Phase 2 demo.

## Claim 1

> Engineered a self-hosted cloud storage system with Fastify, PostgreSQL, and independently deployed storage nodes, separating metadata coordination from binary object storage through an HTTP-based storage interface.

**VERIFIED**, with explicit scope.

- Source: `docker-compose.yml`; `apps/api/src/storage/storage-node-http.ts`; `apps/storage-node/src/app.ts`; `apps/storage-node/src/object-store.ts`; Prisma `StorageNode`/`FileReplica` models.
- Tests: integration “publishes exactly two HEALTHY replicas to two independent HTTP storage nodes”; stopped-container fault tests; Playwright reliability scenario.
- Demo: two node objects and two HEALTHY replicas are verified before corruption.
- Limitation: independently deployed means separate container, process and persistent volume on one host. It does not mean separate physical machines or regions.

## Claim 2

> Built a resumable upload pipeline with 8 MiB chunking, up to 4 parallel workers, persistent upload sessions, and SHA-256 integrity verification, allowing interrupted uploads to resume across browser refreshes and API restarts.

**VERIFIED**.

- Source: `packages/shared/src/index.ts`; `apps/web/src/chunked-upload.ts`; `apps/api/src/modules/uploads/{routes,service}.ts`; `apps/api/src/storage/local-file-storage.ts`; Prisma `UploadSession`/`UploadChunk`.
- Tests: 9 Web uploader tests; 100 MiB PostgreSQL restart/concurrent-resume integration test; Playwright 100 MiB pause, refresh, API restart and request-index assertion.
- Demo: retained chunks 0–6 and sent only 7–12 after API restart; final 100 MiB SHA-256 matched.
- Limitation: browser refresh loses the JavaScript `File` handle. The user must reselect the same file; content-aware identity then reconnects to the persistent server session and sends only missing chunks.

## Claim 3

> Designed a dual-replica architecture with node health monitoring, automatic download fallback, corruption detection, background integrity scrubbing, and self-healing recovery of missing or corrupted replicas.

**VERIFIED**.

- Source: `heartbeat-service.ts`, `integrity-service.ts`, `replica-service.ts`, `scrub-service.ts`, `operation-service.ts`, Storage Node sidecar metadata.
- Tests: actual container outage fallback and 503; corrupt primary never returned; missing/corrupt auto-repair; both-corrupt 503; heartbeat recovery; Playwright timeline.
- Demo: one byte on A was changed, A became CORRUPT, B returned the correct hash, and background repair restored two HEALTHY copies.
- Limitation: with only two configured nodes, a completely unavailable node cannot be replaced into a third domain; the file remains readable but degraded until a target becomes available.

## Claim 4

> Implemented PostgreSQL-backed replica state machines and idempotent recovery operations to handle partial storage failures and coordinator restarts, validated through fault-injection tests covering node outages, corrupted replicas, interrupted uploads, and recovery workflows.

**VERIFIED for the documented single-Coordinator topology**.

- Source: Prisma `File`, `FileReplica`, `StorageNode`, `StorageOperation`; `StorageOperationService.claim`, startup `reconcileIncomplete`, operation/replica unique constraints and idempotent Storage Node PUT/DELETE.
- Tests: partial second-write failure truth; duplicate finalize; RUNNING repair restart recovery; no third healthy replica; concurrent duplicate resume; stopped nodes; corruption and repair.
- Demo: API restart retained upload state and automatic repair converged back to 2/2.
- Limitation: idempotence is proven for retries and restart in the single-Coordinator design. This is not multi-Coordinator consensus or a cross-PostgreSQL/storage ACID transaction.

## Approved wording

The four proposed bullets are accurate when the README remains adjacent and preserves the single-host/single-Coordinator limitation. No wording change is required. In interviews, qualify “independently deployed” as independent containers/processes/volumes and explain the browser file-reselection constraint.

