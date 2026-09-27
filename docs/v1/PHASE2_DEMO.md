# Phase 2 Reproducible Demo

## Commands

```bash
cp .env.example .env
# Set independent 32+ character JWT_SECRET and STORAGE_INTERNAL_TOKEN values in .env.
docker compose up -d --build --wait
node scripts/phase2-demo.mjs
```

The script obtains all PASS conditions from HTTP responses, PostgreSQL, container volumes, and computed SHA-256 values. It does not print hard-coded PASS markers.

## Verified run

The successful 2026-09-26 run produced:

```text
two_replicas_verified: node-a HEALTHY, node-b HEALTHY
sha256: 412f60e4a630f1d60653186ad3d80f2a04e0e1ff779c21f46bf176e304c5a260
replica_corrupted: node-a
corruption_detected: CORRUPT
healthy_fallback_download: 104857600 bytes, matching SHA-256
automatic_repair_complete: 2 HEALTHY, repaired SHA-256 matches
upload_interrupted: 7/13 chunks complete
API restarted
retained chunks: 0,1,2,3,4,5,6
sent after restart: 7,8,9,10,11,12
final download: 104857600 bytes, matching SHA-256
```

The object corruption is a real one-byte write inside Storage Node A's private `/data` volume. The script does not use the test-only fault endpoint. Repair is performed by the normal API background worker through `REPAIR_REPLICA`.

## What the demo proves

- Two separate containers and volumes initially store correct complete replicas.
- Same-size byte corruption is detected by hashing actual bytes, not by trusting sidecar metadata.
- No corrupt bytes reach the downloader.
- A healthy replica provides fallback.
- PostgreSQL exposes the `CORRUPT` state before repair.
- Repair overwrites and verifies the target, returning to two healthy copies.
- Server upload state and chunk files survive API restart.
- Resume transfers exactly the missing chunk set.

## Cleanup

```bash
docker compose stop
# Or, to delete all demo data:
docker compose down --volumes
```
