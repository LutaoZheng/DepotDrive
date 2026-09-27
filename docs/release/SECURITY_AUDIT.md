# Security and Correctness Release Audit

Audit date: 2026-09-27. Scope: authentication/authorization, secrets, paths, upload limits, cleanup, storage integrity and demo controls.

## Findings resolved in this audit

### HIGH — known fallback service secrets

The standard Compose previously allowed known JWT and Storage Node token fallbacks. It now requires `JWT_SECRET` and `STORAGE_INTERNAL_TOKEN`; both are blank in `.env.example`, API requires at least 32 JWT characters outside tests, and API/Storage Node require at least 32 token characters. Compose without either value exits non-zero. Test environments provide isolated fixtures. Every published development/test port is bound to `127.0.0.1`, so local PostgreSQL and internal node APIs are not exposed on all host interfaces.

### MEDIUM — unbounded active upload sessions

Authenticated users could create unlimited unexpired session rows. `MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER` now defaults to 20. Session reuse is evaluated before the limit, and a new session above the cap returns 429 `UPLOAD_SESSION_LIMIT`. A real PostgreSQL integration test passed.

## Authentication and authorization

- Passwords use bcrypt cost 12; credentials accept 8–200 characters.
- Session JWT is stored in an HttpOnly, SameSite=Lax cookie; Secure is environment-controlled.
- Files, folders and upload sessions are always selected with the authenticated owner id. Cross-user file download/delete and upload-session lookup return 404.
- Monitoring and node metadata require a database-backed ADMIN role; frontend visibility is not the security boundary.
- Demo scrub/repair additionally require `DEMO_MODE=true`, exact configured Origin and an explicit CSRF header. With demo mode off the route returns 404.
- The production/default server never creates an administrator. Demo bootstrap runs only in the opt-in Compose override.
- The documented demo account is a local fixture, not embedded in normal authentication logic.

Verified direct API results: unauthenticated monitoring 401; USER monitoring 403; production-mode demo mutation 404; missing-CSRF demo request 403; authorized same-origin demo request 200; cross-user file operations 404.

## File and path security

- Display filenames reject `/`, `\\`, NUL, empty names and excessive length. Names are metadata only.
- Physical object/session paths use server-generated UUIDs and validated numeric chunk indexes.
- Both Coordinator and Storage Node validate object keys before joining filesystem paths.
- Writes use unique temporary files and atomic link/rename publication; failed temporary files are removed.
- Chunk indexes must fall inside the persisted session range. Chunk body limit is configured chunk size plus 1 KiB, and exact expected size/hash is verified.
- Overall file size defaults to 5 GiB and is checked before session creation; legacy multipart uses the same upper limit.
- No arbitrary filesystem path or shell string is accepted from an HTTP request. Demo scripts use argument-array process execution and fixed service names.

No traversal, arbitrary overwrite/read or shell-injection release blocker was found.

## Resource exhaustion

Existing bounded controls include 5 GiB file size, 8 MiB chunks, four browser workers per file, two concurrent queued browser files, 20 active sessions per user, per-request body limits, 24-hour abandoned-session TTL, hourly cleanup, bounded scrub/repair batches, request timeouts and non-overlapping single-process worker ticks.

Non-blocking gaps: no login/registration rate limiter, no per-user byte quota, no server-side concurrent chunk semaphore, no total staging-disk reservation, and no JWT revocation list. These are acceptable for the documented single-host portfolio deployment but must be revisited before hostile public exposure.

## Storage correctness

Actual-byte downloads are staged and streaming-hashed before response bytes begin. Wrong size/checksum changes replica state and falls through to another healthy copy; all unusable copies return 503. Durable `REPAIR_REPLICA` operations, conditional claims and uniqueness constraints make retry/restart idempotent in the supported single-Coordinator model.

## Portfolio screenshot review

The curated set contains three non-duplicative images: ordinary Drive/file details, healthy System Monitor, and Reliability Demo with topology, replica state and repair timeline. Together they show normal user experience and distributed-storage behavior. Fixture identities are non-personal, and no token, host path or private filename is visible. Separate login/upload-progress/CORRUPT screenshots would be optional presentation improvements, not release blockers; the existing reliability image already shows a failed scrub and restored replica from a real run.

## Severity summary

- BLOCKER: 0 code/security findings.
- HIGH: 1 found and fixed.
- MEDIUM: 1 found and fixed; remaining resource-hardening items are documented non-blocking limitations.
- LOW/INFO: local database credentials and HTTP-only internal traffic are appropriate only for the explicitly local Compose environment.
