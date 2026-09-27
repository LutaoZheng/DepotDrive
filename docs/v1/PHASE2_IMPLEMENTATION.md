# Phase 2 Implementation — Data Integrity & Self-Healing

## Outcome

Phase 2 adds byte-level replica verification, durable automatic repair, periodic scrubbing, and resumable browser uploads that survive page/API restarts. It does not add a new infrastructure dependency: PostgreSQL remains the durable operation queue.

## Core changes

### Authoritative integrity metadata

`FileReplica.sizeBytes` and `FileReplica.sha256` are Coordinator-owned expected values. `lastVerifiedAt` records the last successful byte verification. Storage Nodes persist `{sizeBytes, sha256}` beside each object in an atomic `.metadata.json` sidecar and rebuild a missing sidecar after restart.

Storage Node metadata is an optimization, not proof of integrity. The Coordinator verifies actual bytes against PostgreSQL before download or repair.

### Safe read path

`IntegrityService.stageVerified` performs:

1. Node and replica eligibility check.
2. `HEAD` metadata comparison.
3. Remote `GET` into a unique API staging object while computing streaming SHA-256 and size.
4. PostgreSQL transition to `MISSING`, `CORRUPT`, or `UNAVAILABLE` on failure.
5. Only after verification, return a local read stream to Fastify.

This intentionally trades time-to-first-byte and Coordinator disk I/O for a strong property: corrupted bytes are never sent before a late checksum mismatch is known.

### Durable repair

`REPAIR_REPLICA` uses the existing `StorageOperation` table. A repair verifies a different `HEALTHY` source into staging, atomically replaces the target object with expected size/SHA-256 headers, verifies target metadata, and commits the target replica plus operation state in one PostgreSQL transaction.

The `(type, replicaId)` unique constraint and conditional operation claim prevent duplicate concurrent work in the single-Coordinator model. A `RUNNING` operation becomes `PENDING` at startup and is retried idempotently. With a third configured healthy node, the worker can create a replacement replica on a node not already used by that file. The supplied Compose topology has only two nodes, so a completely down node leaves the file degraded until that node returns.

### Scrubbing

The scrubber selects `HEALTHY` replicas ordered by `lastVerifiedAt` (null/oldest first), verifies a configurable batch, preserves failed metadata, and enqueues repair. Production defaults are conservative; Docker Compose uses a shorter local repair interval for demonstration.

### Persistent upload resume

The browser derives `clientUploadId` from full-file SHA-256, name, size, and `lastModified`. It persists only session metadata in `localStorage`; it never attempts to persist the browser `File` object. After refresh, the UI asks the user to choose the same file. The API returns the existing unexpired session and its completed chunk indexes, so only missing chunks are sent.

Chunk publication now uses an atomic filesystem link. Concurrent identical writes converge on one physical chunk and one unique PostgreSQL row; conflicting bytes fail with `CHUNK_CONFLICT`. Expired `ACTIVE` sessions remove both chunk files and database metadata without touching completed files.

## Schema migration

Migration: `apps/api/prisma/migrations/20260927000000_phase2_integrity/migration.sql`

- `ReplicaStatus`: adds `CORRUPT`.
- `StorageOperationType`: adds `REPAIR_REPLICA`.
- `FileReplica.lastVerifiedAt DateTime?` plus verification index.
- `UploadSession.clientUploadId String?`.
- `UploadSession.lastModified BigInt?`.
- Unique `(ownerId, clientUploadId)` upload identity.

## Main files

- `apps/api/src/modules/storage/integrity-service.ts`
- `apps/api/src/modules/storage/operation-service.ts`
- `apps/api/src/modules/storage/scrub-service.ts`
- `apps/api/src/modules/storage/replica-service.ts`
- `apps/storage-node/src/object-store.ts`
- `apps/storage-node/src/app.ts`
- `apps/api/src/modules/uploads/service.ts`
- `apps/api/src/storage/local-file-storage.ts`
- `apps/web/src/chunked-upload.ts`
- `apps/web/src/pages/DrivePage.tsx`
- `scripts/phase2-demo.mjs`

## Compatibility

Registration, login, folders, multipart upload, chunk upload, pause/resume/cancel, list, download, rename, delete, usage, and the storage dashboard remain available. Existing upload-create clients may omit the new identity fields; durable browser resume uses them.
