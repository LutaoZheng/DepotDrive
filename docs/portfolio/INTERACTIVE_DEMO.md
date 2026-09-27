# Interactive Reliability Demo

## Start

```bash
cp .env.example .env
# Set independent 32+ character JWT_SECRET and STORAGE_INTERNAL_TOKEN values in .env.
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build --wait
```

Open `http://localhost:5173` and sign in with the local-only defaults `demo@depotdrive.local` / `DepotDemo123!`. Override `DEMO_ADMIN_EMAIL` and `DEMO_ADMIN_PASSWORD` when desired. The normal production Compose does not create this account or expose demo actions.

## Pages

- My Drive: upload a real file and inspect its SHA-256.
- System Monitor: watch live heartbeats, replica counts, under-replication, repairs and scrub timestamps. Polling is every three seconds.
- Reliability Demo: select the file to see authoritative replicas and persisted events. `Run scrub` and `Run repair` are narrow authenticated actions.

## Real fault controls

Container and filesystem faults intentionally stay in the terminal:

```bash
docker compose stop storage-node-a
docker compose start storage-node-a
docker compose stop storage-node-a storage-node-b
docker compose start storage-node-a storage-node-b
```

The page should show node state after the configured heartbeat window. With A stopped, download succeeds from B. With both stopped, the same existing file returns 503, never 404. Restore either node and download recovers.

For the repeatable corruption + repair + resume sequence:

```bash
node scripts/phase2-demo.mjs
```

This fixed script only targets DepotDrive containers and known object paths. It outputs observations and hashes from real calls; it does not print hard-coded PASS messages.

## Safety model

The API and Web containers never receive `/var/run/docker.sock`. There is no generic command endpoint. Production mode returns 404 for demo mutation routes. In local demo mode, the only web mutations are scrub and repair; both require persisted ADMIN authorization, exact Origin, CSRF header, schema-validated routing and normal request logs. Node stop/start and corruption remain explicit CLI actions.

## Reset

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml down --volumes
```

This removes the local PostgreSQL, upload-staging and both Storage Node volumes.
