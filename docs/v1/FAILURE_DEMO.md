# DepotDrive Phase 1 Failure Demo

Execution date: 2026-09-26.

## Commands executed

```bash
# Ensure .env contains independent 32+ character JWT_SECRET and STORAGE_INTERNAL_TOKEN values.
docker compose up -d --build --wait
docker compose ps
node scripts/failure-demo.mjs
```

The script itself executes the equivalent of:

```bash
docker compose stop storage-node-a
docker compose start storage-node-a
docker compose stop storage-node-b
docker compose stop storage-node-a
docker compose start storage-node-a
docker compose restart api
```

It restores A, B, and API before exit.

## Test file

- Size: `104857600` bytes (100 MiB)
- Chunk size: 8 MiB
- Total chunks: 13
- Parallel upload workers: 4
- Original SHA-256: `412f60e4a630f1d60653186ad3d80f2a04e0e1ff779c21f46bf176e304c5a260`
- File id: `034a6724-5747-4c87-830a-ce3f26aa7972`

## Recorded output

```json
{"step":"uploaded_chunks","bytes":104857600,"chunks":13,"parallelism":4,"originalSha256":"412f60e4a630f1d60653186ad3d80f2a04e0e1ff779c21f46bf176e304c5a260"}
{"step":"file_available","fileId":"034a6724-5747-4c87-830a-ce3f26aa7972","status":"AVAILABLE","replicas":[{"nodeId":"node-a","status":"HEALTHY","sizeBytes":104857600,"sha256":"412f60e4a630f1d60653186ad3d80f2a04e0e1ff779c21f46bf176e304c5a260"},{"nodeId":"node-b","status":"HEALTHY","sizeBytes":104857600,"sha256":"412f60e4a630f1d60653186ad3d80f2a04e0e1ff779c21f46bf176e304c5a260"}]}
{"step":"independent_volumes_verified","volumeA":"depotdrive_storage_a_data","volumeB":"depotdrive_storage_b_data"}
{"step":"node_a_stopped","status":200,"sha256":"412f60e4a630f1d60653186ad3d80f2a04e0e1ff779c21f46bf176e304c5a260","bytes":104857600}
{"step":"node_b_stopped_node_a_download","status":200,"sha256":"412f60e4a630f1d60653186ad3d80f2a04e0e1ff779c21f46bf176e304c5a260","bytes":104857600}
{"step":"both_nodes_stopped","status":503,"body":{"error":{"code":"FILE_UNAVAILABLE","message":"File exists but all replicas are currently unavailable"}}}
{"step":"one_node_restored","status":200,"sha256":"412f60e4a630f1d60653186ad3d80f2a04e0e1ff779c21f46bf176e304c5a260","bytes":104857600}
{"step":"api_restarted_metadata_persisted","download":{"status":200,"sha256":"412f60e4a630f1d60653186ad3d80f2a04e0e1ff779c21f46bf176e304c5a260","bytes":104857600},"fileStatus":"AVAILABLE"}
```

## Acceptance mapping

| Required step | Result |
|---|---|
| Start full Compose | PASS |
| Create user | PASS |
| Upload at least 100 MB | PASS — 100 MiB chunked upload |
| Verify two independent node objects | PASS — physical object test in both containers |
| Verify independent volumes | PASS — distinct named volumes recorded |
| Record original SHA-256 | PASS |
| Stop A and download | PASS — 200 and matching SHA-256 |
| Start A, stop B, download | PASS — 200 and matching SHA-256 |
| Stop A+B | PASS — 503 FILE_UNAVAILABLE, not 404 |
| Restore one node | PASS — download returns 200 |
| Restart API | PASS — download and AVAILABLE metadata persist |

## What this demo does not claim

- It does not prove automatic repair; no replacement replica is created in Phase 1.
- It does not prove corruption detection; downloads are externally hashed by the demo, while the API verifies HEAD size only.
- It does not prove multi-region or physical-machine isolation. It proves separate processes, containers, and Docker volumes on one development host.
