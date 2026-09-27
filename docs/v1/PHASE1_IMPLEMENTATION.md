# DepotDrive V1.0 Phase 1 Implementation

Implemented on 2026-09-26. Scope: Core Reliability only. No automatic repair, scrubber, Kubernetes, Redis, Kafka, RabbitMQ, S3, or public deployment was added.

## Outcome

Phase 1 replaces three local directories owned by the API with two separately running Storage Node services. Each node owns its filesystem and Docker volume. The API is now a coordinator: it writes durable file/replica/operation intent to PostgreSQL, performs idempotent HTTP operations, publishes a file only after two replicas are healthy, and uses explicit 404 versus 503 failure semantics.

## Major changes

### Independent Storage Node service

Added `apps/storage-node` with a small Fastify server and filesystem `ObjectStore`.

- Each Docker service runs a separate Node.js process.
- A and B mount `storage_a_data` and `storage_b_data`; the API mounts neither.
- Writes use a unique temporary file, streaming size/SHA-256 calculation, validation, then atomic rename.
- Repeating an identical PUT is idempotent. A different object at the same key returns conflict.
- HEAD recalculates metadata from physical bytes, so the coordinator can at least validate existence and size in Phase 1.
- The production service exposes health and object operations only with an internal bearer token.

Core files:

- `apps/storage-node/src/app.ts`
- `apps/storage-node/src/object-store.ts`
- `apps/storage-node/src/server.ts`
- `apps/storage-node/Dockerfile`
- `apps/api/src/storage/storage-node-http.ts`

### Docker topology

`docker-compose.yml` now contains:

- `web`
- `api`
- `postgres`
- `storage-node-a`
- `storage-node-b`

Persistent volumes are `postgres_data`, `api_uploads_data`, `storage_a_data`, and `storage_b_data`. `api_uploads_data` contains only upload sessions/staging. It is not a replica failure domain.

### Database lifecycle

Migration `20260926000000_phase1_reliability` adds:

- `FileStatus`: `PENDING`, `AVAILABLE`, `DELETING`
- `ReplicaStatus`: `PENDING`, `HEALTHY`, `MISSING`, `UNAVAILABLE`, `DELETE_PENDING`
- `StorageOperationType`: `CREATE_REPLICA`, `DELETE_REPLICA`
- `StorageOperationStatus`: `PENDING`, `RUNNING`, `DONE`, `FAILED`
- `File.uploadSessionId` for a durable finalize association
- `FileReplica.status`, `sizeBytes`, `sha256`, `updatedAt`
- `StorageNode.endpoint`, renamed `lastHeartbeatAt`, and `HEALTHY`/`UNAVAILABLE`
- `StorageOperation` with file, replica, node, attempts, lastError, and timestamps

Existing files migrate to `AVAILABLE`; existing replicas migrate to `HEALTHY` and inherit file size/checksum.

### Reliable publication

The publication path is:

1. Assemble chunks in API staging and verify final SHA-256.
2. Refresh node health and select two nodes.
3. In one PostgreSQL transaction create `File(PENDING)`, two `FileReplica(PENDING)`, and two `CREATE_REPLICA(PENDING)` rows.
4. Claim each operation as `RUNNING`, PUT the staging object to its target node, and verify returned size/SHA-256.
5. Atomically mark operation `DONE` and replica `HEALTHY`; on error mark operation `FAILED` and replica `UNAVAILABLE` with `lastError` retained.
6. When two replicas are healthy, mark file `AVAILABLE`, remove UploadSession metadata, and best-effort remove staging/chunks.

If the coordinator exits after a physical write, the `RUNNING` operation remains durable. At startup `reconcileIncomplete()` resets abandoned RUNNING operations to PENDING, retries PENDING/FAILED operations idempotently, and recomputes file availability.

Repeated finalize cannot create another file because `File.uploadSessionId` is unique while completion is in progress. After successful publication the session is removed, so a later duplicate gets 404 without duplicate file/replica rows.

### Durable deletion

Delete changes the file to `DELETING`, replicas to `DELETE_PENDING`, and creates `DELETE_REPLICA` operations. Node DELETE is idempotent. Metadata is removed only when every delete operation is DONE. If a node is unavailable, the API returns 503 and the durable operation remains for startup reconciliation.

### Download failure semantics

- File metadata not found or owned by a different user: 404.
- File exists but every eligible replica is unavailable: 503 `FILE_UNAVAILABLE`.
- For each candidate, the coordinator checks node heartbeat freshness, performs HEAD, validates expected size, then opens GET.
- Missing object becomes `MISSING`; transport/timeout failure becomes `UNAVAILABLE`; either case falls through to the next replica.
- A successful later probe can move `UNAVAILABLE` back to `HEALTHY`.

Full read-time SHA-256 validation is intentionally deferred to Phase 2.

### Heartbeat

The existing heartbeat loop now probes remote `/health` endpoints. Endpoint, status, capacity, used bytes, and last successful heartbeat are stored in PostgreSQL. A stopped container becomes `UNAVAILABLE`; a restarted node becomes `HEALTHY`. Heartbeat does not create replacement replicas.

### Integration-test baseline

`docker-compose.test.yml` provides a dedicated PostgreSQL database and two disposable Storage Nodes. `scripts/test-all.sh`:

1. Builds and starts the isolated topology.
2. Exports `TEST_DATABASE_URL` and test node endpoints.
3. Applies committed Prisma migrations.
4. Runs unit tests.
5. Runs PostgreSQL + real HTTP/container fault tests.
6. Removes containers and test volumes with a shell trap.

`integration.test.ts` throws if `TEST_DATABASE_URL` or node endpoints are missing. It never uses `describe.skip`.

## Compatibility

Authentication, folder operations, legacy multipart upload, chunked create/resume/cancel/complete, file list/download/rename/delete, usage totals, and the dashboard keep their existing public URLs. PENDING/DELETING files are hidden from directory lists and usage totals until their state is user-visible.

## Limitations remaining

- No automatic replacement of MISSING/UNAVAILABLE replicas.
- No background checksum scrub or full content validation on download.
- Only one coordinator is supported; there is no cross-coordinator operation lease.
- Startup reconciliation is the Phase 1 runner; there is no continuously scheduled retry/backoff worker.
- Cleanup errors are logged, but there is no complete physical orphan inventory.
- Storage-node bearer token is a shared local-development secret; production secret distribution/TLS is outside this phase.

## Phase 2 recommendation

Build a bounded reconciler that selects under-replicated AVAILABLE files, verifies a healthy source, creates a replacement replica with a PostgreSQL lease, and later add low-rate checksum scrubbing. Keep the existing operation table rather than introducing a message queue.
