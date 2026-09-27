# DepotDrive V1.0 Architecture (Final)

## Runtime topology

```text
Browser / React
  ├─ localStorage: resumable-session metadata only
  ├─ Drive + upload manager
  ├─ admin System Monitor + Reliability Demo
  └─ HTTPS/HTTP
       ↓
Fastify API / single Coordinator
  ├─ auth + ownership
  ├─ 8 MiB upload sessions / four browser workers
  ├─ authoritative size + SHA-256
  ├─ verified-download staging
  ├─ heartbeat, scrub, and repair workers
  └─ durable operation reconciler
       ├──────── PostgreSQL
       │           users, files, sessions, chunks,
       │           nodes, replicas, operations, system events
       ├─ authenticated HTTP ─ Storage Node A ─ storage_a_data
       └─ authenticated HTTP ─ Storage Node B ─ storage_b_data

API staging ─ api_uploads_data (not mounted by Storage Nodes)
```

All five services run on one Docker host. Storage A and B have independent containers, processes, and named volumes. The API mounts neither node volume and accesses objects only over HTTP.

## Monitoring and demo plane

`GET /api/monitoring/overview` requires an authenticated persisted `ADMIN` role and returns a single real snapshot of Coordinator/database health, heartbeat-backed node state, replica counts, under-replication, active repairs, scrub/verification timestamps, file replicas and recent `SystemEvent` rows. React polls every three seconds. A failed refresh overrides cached green state with `DISCONNECTED`.

`SystemEvent` persists heartbeat transitions, failed/passed verification, download fallback, repair start/result and scrub completion. The Reliability Demo timeline therefore survives reloads and Coordinator restarts.

Production Compose leaves `DEMO_MODE=false`. The local demo override permits only authenticated same-origin scrub/repair endpoints with an explicit CSRF header. Docker stop/start and corruption stay in a fixed local CLI path; neither API nor Web mounts the Docker socket.

## Upload and publish

```text
select file → streaming browser SHA-256 → create/reuse UploadSession
  → GET completed chunk indexes → PUT only missing chunks (≤4 concurrent)
  → assemble + verify staging object
  → File PENDING + two Replica PENDING + two CREATE_REPLICA operations
  → verified PUT A → A HEALTHY
  → verified PUT B → B HEALTHY
  → File AVAILABLE → remove chunks/staging
```

Partial network/database/storage failure remains visible in PostgreSQL. There is no fictitious cross-system ACID transaction.

## Integrity-safe download

```text
authorize File
  → choose HEALTHY replica on HEALTHY/fresh node
  → HEAD against authoritative metadata
  → GET to unique Coordinator staging while hashing bytes
  ├─ mismatch: preserve MISSING/CORRUPT/UNAVAILABLE, enqueue repair, try next
  └─ match: set lastVerifiedAt, then stream staged verified bytes to client
```

No response body begins before validation completes. Metadata absent/unauthorized is 404. Existing file without a trustworthy copy is 503 `FILE_UNAVAILABLE`.

## Repair and scrub

```text
scrub/download detects bad target
  → upsert REPAIR_REPLICA(PENDING)
  → claim RUNNING
  → verify different HEALTHY source into staging
  → atomic replace on target
  → verify target metadata
  → target HEALTHY + operation DONE
```

Startup resets `RUNNING` to `PENDING` and retries. Unique database constraints prevent duplicate per-node replicas and duplicate target repair operations.

## Storage Node contract

All routes require the internal bearer token.

| Method | Path | Semantics |
|---|---|---|
| `GET` | `/health` | Liveness and capacity |
| `PUT` | `/objects/:objectKey` | Streaming atomic write with required size/SHA-256 |
| `HEAD` | `/objects/:objectKey` | Persistent sidecar size/SHA-256 |
| `GET` | `/objects/:objectKey` | Object byte stream |
| `DELETE` | `/objects/:objectKey` | Idempotent object + sidecar removal |

Repair adds internal header `X-Allow-Replace: true`. The test-only fault endpoints are registered only with `ENABLE_FAULT_INJECTION=true`.

## Persisted state

- File: `PENDING`, `AVAILABLE`, `DELETING`.
- Replica: `PENDING`, `HEALTHY`, `MISSING`, `UNAVAILABLE`, `CORRUPT`, `DELETE_PENDING`.
- Operation type: `CREATE_REPLICA`, `DELETE_REPLICA`, `REPAIR_REPLICA`.
- Operation state: `PENDING`, `RUNNING`, `DONE`, `FAILED`.
- Node: `HEALTHY`, `UNAVAILABLE`, endpoint, capacity, `lastHeartbeatAt`.
- Upload: identity, expected file metadata, chunk rows, expiration, and completion state.
- User: `USER` or persisted `ADMIN` role.
- System event: type, result, time, related file/replica/node and bounded JSON metadata.

## Explicit boundaries

This is a single-host, single-Coordinator system. Storage failures are independent at the container/process/volume level, not at machine or region level. With only two configured nodes, one fully down node means one available copy until it recovers. The system does not claim multi-machine consensus, arbitrary simultaneous-failure durability, or zero data loss.
