# 75-Second Demo Video Script

## 0–10 seconds — Architecture

Show the Reliability Demo topology and say: “DepotDrive separates a Fastify metadata Coordinator from PostgreSQL and two HTTP Storage Node containers with independent volumes.”

## 10–25 seconds — Upload

Open My Drive, select a 100 MiB file, and show percentage, chunk count, active workers and actual throughput. Open file details to show its SHA-256. Switch to System Monitor and point to two HEALTHY replicas.

## 25–38 seconds — Node failure

In a visible terminal run `docker compose stop storage-node-a`. Return to Monitor until A becomes UNAVAILABLE. Download the file, then run a visible SHA-256 check and show that it matches: “The Coordinator verified and fell back to Node B.”

## 38–55 seconds — Corruption and repair

Run `node scripts/phase2-demo.mjs` or the documented fixed corruption step. On Reliability Demo, run scrub and point to the real `REPLICA CORRUPT`, `REPAIR STARTED`, and `REPLICA RESTORED` events. Show A and B back at HEALTHY 2/2.

## 55–70 seconds — Browser/API resume

Start a second 100 MiB upload, pause around half, refresh, restart the API in the terminal, then reselect the file. Show the resume notice and that only the remaining chunks advance. Mention that session metadata persists but the browser requires file reselection.

## 70–75 seconds — Close

Return to topology: “Fault injection, PostgreSQL integration and browser resume run in the default 55-test quality gate. This is a single-host, single-Coordinator system—not a multi-region claim.”

Keep terminal commands and SHA output readable; do not accelerate past the actual state transitions or overlay synthetic success graphics.
