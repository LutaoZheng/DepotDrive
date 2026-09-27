# Resume Claim Verification

## 1. HTTP-separated object storage

**VERIFIED with scope clarification.** `docker-compose.yml` defines separate API, PostgreSQL, Storage Node A and Storage Node B containers; the nodes have independent processes and named volumes. `apps/api/src/storage/storage-node-http.ts` is the Coordinator interface and `apps/storage-node/src/object-store.ts` performs atomic temp-file publication. The API mounts no Storage Node volume.

Tests: integration case “publishes exactly two HEALTHY replicas…” and browser fault scenario. Both passed. Limitation: “independently deployed” means independent containers/processes/volumes on one physical host, not independent machines or regions.

## 2. Resumable 8 MiB, four-worker upload

**VERIFIED.** `apps/web/src/chunked-upload.ts` defines 8 MiB chunking, at most four concurrent workers, whole-file/chunk SHA-256, localStorage session metadata, content-aware upload identity and server-authoritative completed-chunk lookup. `apps/api/src/modules/uploads/service.ts` persists sessions/chunks, uniquely scopes `clientUploadId` per owner and idempotently handles duplicates. `apps/api/src/storage/local-file-storage.ts` assembles to a temporary file, verifies size/hash and atomically renames.

Tests: Web uploader tests, 100 MiB integration restart/duplicate resume, Playwright 100 MiB refresh + API restart test, and `scripts/phase2-demo.mjs`; all passed. The browser test proved resume requests exactly matched the post-restart missing set. Limitation: after refresh the user must reselect the original file because browsers do not persist a reusable `File` object.

## 3. Replication, fallback, scrubbing and self-healing

**VERIFIED.** `replica-service.ts` verifies candidate bytes in Coordinator staging before returning them, so a late hash failure cannot leak corrupted response bytes. `integrity-service.ts` compares authoritative size/SHA-256. `heartbeat-service.ts`, `scrub-service.ts`, and `operation-service.ts` persist node/replica states and drive fallback and repair. Storage Nodes persist checksum sidecars across restarts.

Tests: stopped A fallback, both stopped 503, same-size corruption fallback/repair, missing repair, both-corrupt 503, heartbeat transitions, browser corruption timeline; all passed. Limitation: with exactly two nodes, a completely down node cannot be replaced into another failure domain because no third node exists.

## 4. Durable state machines and restart recovery

**VERIFIED for a single Coordinator.** Prisma models `FileReplica`, `StorageNode`, `StorageOperation`, `UploadSession`, `UploadChunk` and `SystemEvent` persist state. Unique constraints prevent duplicate file/node replicas and duplicate operation/replica combinations. Startup reconciliation resets interrupted RUNNING work to retryable state; operations use idempotent remote writes and verification.

Tests: partial replication reconciliation, RUNNING repair recovery without a third replica, duplicate finalize, concurrent duplicate resume, and browser API restart; all passed. Limitation: this is PostgreSQL coordination for one Coordinator, not leader election, consensus or an arbitrary multi-Coordinator guarantee. PostgreSQL and network storage do not share an ACID transaction; failures converge through durable visible state.

## Accurate portfolio wording

All four proposed bullets are supported when the repository also states the single-host/single-Coordinator boundary. “Atomic assembly” applies to publication inside each filesystem using temp + rename; it does not imply an atomic transaction spanning PostgreSQL and two remote nodes. “Corruption detection” is safe because bytes are fully staged and SHA-256 verified before the HTTP response body begins.
