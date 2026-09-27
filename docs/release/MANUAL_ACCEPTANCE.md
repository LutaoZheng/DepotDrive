# Final Manual Acceptance Checklist

Use this checklist from the repository root. It requires Docker Desktop, Node.js 20+, npm and a browser.

## Step 1 — Prepare local secrets

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Open `.env`. Paste the first generated value after `JWT_SECRET=` and the second after `STORAGE_INTERNAL_TOKEN=`. Do not reuse the demo password as either secret.

Expected: neither variable is blank and both have at least 32 characters.

## Step 2 — Start the demo topology

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build --wait
docker compose -f docker-compose.yml -f docker-compose.demo.yml ps
```

Expected: `web`, `api`, `postgres`, `storage-node-a` and `storage-node-b` are running; health-enabled services report healthy. Migrations run automatically before API startup.

## Step 3 — Verify an ordinary user

Open `http://localhost:5173/register`. Create a disposable user, then open My Drive.

Expected: Drive loads, but System Monitor and Reliability Demo navigation are absent. Upload a small file, open its row/details, download it, rename it and delete it. Expected: real size/SHA-256 appears, download works, delete asks for confirmation.

## Step 4 — Sign in as the local demo administrator

Sign out and open `http://localhost:5173/login`. Use the demo account documented in `docker-compose.demo.yml`/README, or your overridden `DEMO_ADMIN_EMAIL` and `DEMO_ADMIN_PASSWORD`.

Expected: My Drive, System Monitor and Reliability Demo navigation are visible.

## Step 5 — Upload a 100 MiB browser file

Generate an input outside the repository:

```bash
mkfile -n 100m /tmp/depotdrive-manual-100mb.bin
shasum -a 256 /tmp/depotdrive-manual-100mb.bin
```

On My Drive click the upload selector and choose that file.

Expected: progress shows 13 chunks, no more than 4 active workers, measured speed, completion notification and AVAILABLE file details. System Monitor should show two HEALTHY replicas and replication 2/2.

## Step 6 — Verify browser resume

Start another 100 MiB upload. After several chunks, click Pause. Record completed/total chunks, refresh the page, then restart the API:

```bash
docker compose restart api
```

Return to My Drive and reselect the exact same local file.

Expected: the resume notice explains file reselection; progress continues from server-completed chunks rather than zero and finishes with the same SHA-256.

## Step 7 — Stop Node A

```bash
docker compose stop storage-node-a
```

Open `http://localhost:5173/monitor` and wait through the heartbeat timeout.

Expected: Node A becomes UNAVAILABLE, cached green is not retained. Download the 100 MiB file and hash it; it must match the original through Node B fallback.

## Step 8 — Verify complete outage semantics

```bash
docker compose stop storage-node-b
```

Attempt the same download.

Expected: both nodes show unavailable and the request returns 503 `FILE_UNAVAILABLE`, not 404. The file metadata remains present.

Restore both nodes:

```bash
docker compose start storage-node-a storage-node-b
```

Expected: heartbeats return to HEALTHY and download succeeds again.

## Step 9 — Run real corruption and recovery

Keep `http://localhost:5173/reliability` open in the browser, then run:

```bash
node scripts/phase2-demo.mjs
```

Expected terminal evidence: two HEALTHY replicas; Node A byte corruption; CORRUPT detection; a correct 100 MiB fallback hash; automatic repair to two HEALTHY replicas; interrupted second upload retaining 0–6 and sending only 7–12 after API restart.

Refresh Reliability Demo and select the generated test file.

Expected timeline: `REPLICA_CORRUPT`, `REPAIR_STARTED`, `REPLICA_RESTORED`, and scrub/verification events with real timestamps. Replica status converges to HEALTHY 2/2.

## Step 10 — Verify monitoring disconnect behavior

```bash
docker compose stop api
```

Expected: Monitor reports disconnected and does not leave stale green health. Then restore:

```bash
docker compose start api
```

Expected: polling reconnects and fresh state returns.

## Step 11 — Run the automated gate

```bash
npm install
npm run prisma:generate
npm run typecheck
npm run build
npm test
```

Expected current baseline: 55 passed, 0 failed, 0 skipped.

## Step 12 — Stop or reset

Preserve data:

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml down
```

Delete all local database/upload/node volumes:

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml down --volumes
```

