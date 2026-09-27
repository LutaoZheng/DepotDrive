# Self-Healing Design

## Replica states

```text
PENDING ──verified write──> HEALTHY
HEALTHY ──object absent───> MISSING
HEALTHY ──size/hash wrong─> CORRUPT
HEALTHY ──transport fail──> UNAVAILABLE
MISSING/CORRUPT/UNAVAILABLE ──verified repair──> HEALTHY
any state ──delete request──> DELETE_PENDING
```

Only `HEALTHY` replicas are download candidates. Failure states remain in PostgreSQL; the system does not delete evidence to make replication appear healthy.

## Detection

`HEAD` catches missing objects, wrong size, and stored checksum disagreement cheaply. Full `GET` plus streaming hash catches same-size byte corruption and stale/tampered sidecar metadata. A verified object is first staged inside the Coordinator and is exposed to the client only after the final digest matches.

The sidecar survives Storage Node restart and makes `HEAD` inexpensive. It is deliberately not trusted as the final integrity authority.

## Repair trigger and grace

- `MISSING` and `CORRUPT`: immediately eligible.
- `PENDING`: eligible for reconciliation.
- `UNAVAILABLE`: eligible only after `REPAIR_UNAVAILABLE_GRACE_MS` and a healthy target exists.
- A node-wide heartbeat outage is converted to replica `UNAVAILABLE` only after the same grace period.

This avoids copying large amounts of data for a short node restart. In the two-node topology, a down node cannot be replaced while the only other node already holds the source replica. The file remains readable but under-replicated. No second failure is claimed to be safe.

## Repair algorithm

1. Upsert one `REPAIR_REPLICA` operation per target replica.
2. Atomically claim `PENDING`/`FAILED` as `RUNNING` and increment attempts.
3. Select a different `HEALTHY` replica on a `HEALTHY` node.
4. Download and hash source bytes into unique staging.
5. PUT the verified object to the target with explicit `X-Allow-Replace: true`.
6. Verify target metadata.
7. Commit replica `HEALTHY`, `lastVerifiedAt`, and operation `DONE` together.
8. Delete staging.

On API crash, startup changes all `RUNNING` operations to `PENDING` and safely retries. Object writes are atomic temp-file renames. The target key is stable and repair replacement is idempotent.

## Concurrency

The database unique key `(operation type, replicaId)` prevents duplicate repair jobs for one target. Conditional `updateMany` claiming allows only one runner to move a pending job to running. `(fileId, nodeId)` prevents duplicate replica metadata on one failure domain. This is sufficient for the supported single-Coordinator deployment; it is not a distributed lease protocol.

## Scrubbing

`ScrubService` checks a bounded oldest-first batch. Defaults:

- `SCRUB_INTERVAL_MS=21600000` (six hours)
- `SCRUB_BATCH_SIZE=10`
- `REPAIR_INTERVAL_MS=30000`
- `REPAIR_UNAVAILABLE_GRACE_MS=300000`

Docker Compose shortens the local repair interval to make the demo observable. It does not hash every object every few seconds.
