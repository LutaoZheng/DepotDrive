# DepotDrive V0.3.1

English | [简体中文](./README.zh-CN.md)

## Overview

DepotDrive is a self-hosted private cloud drive. V0.3.1 separates metadata from binary storage and introduces three independently rooted storage nodes, two-copy replication, heartbeat-based failure detection, and replica download fallback.

## Features

- Register, sign in, sign out, and restore a cookie-based session
- Browse root and arbitrarily nested folders with breadcrumbs
- Create, rename, and delete empty folders
- Split files into 8 MiB chunks, upload up to four chunks in parallel, resume missing chunks, and cancel uploads
- Validate every chunk and the assembled file with SHA-256 before publishing metadata
- Stream downloads; rename display metadata; delete metadata and disk content
- Per-user storage totals, loading/error/empty states, and responsive Drive UI
- Owner-scoped resource lookups that return 404 for another user's resources
- Two copies per new file across Storage A/B/C with primary-to-replica download fallback
- Storage-node heartbeat, 30-second failure detection, capacity accounting, and a live dashboard

## Technology

React, TypeScript, Vite, Tailwind CSS, React Router, TanStack Query, and Axios power the web app. The modular-monolith API uses Node.js, Fastify, Prisma, PostgreSQL, JWT, bcrypt, Zod, and multipart streams. npm workspaces manage the monorepo; Docker Compose runs the full stack.

## Architecture

```mermaid
flowchart TD
  Web[React Web] --> API[Fastify Metadata Service]
  API --> DB[(PostgreSQL File, Node and Replica Metadata)]
  API --> Registry[Storage Node Registry]
  Registry --> A[Storage Node A]
  Registry --> B[Storage Node B]
  Registry --> C[Storage Node C]
  A --> AFS[(storage-nodes/A)]
  B --> BFS[(storage-nodes/B)]
  C --> CFS[(storage-nodes/C)]
  Heartbeat[Heartbeat and Failure Detector] --> Registry
  Heartbeat --> DB
```

The Fastify modular monolith currently hosts the Metadata Service, but binary storage is behind a transport-neutral `StorageNode` interface. `StorageNodeLocal` gives A/B/C separate roots today; later remote implementations can replace individual nodes without changing upload or download routes. `LocalFileStorage` remains the staging and V0.2 compatibility implementation.

## Database ER diagram

```mermaid
erDiagram
  User ||--o{ Folder : owns
  User ||--o{ File : owns
  User ||--o{ UploadSession : owns
  Folder o|--o{ Folder : contains
  Folder o|--o{ File : contains
  Folder o|--o{ UploadSession : targets
  UploadSession ||--o{ UploadChunk : contains
  File ||--o{ FileReplica : has
  StorageNode ||--o{ FileReplica : stores

  User {
    uuid id PK
    string email UK
    string passwordHash
    datetime createdAt
    datetime updatedAt
  }

  Folder {
    uuid id PK
    uuid ownerId FK
    uuid parentId FK
    string name
    datetime createdAt
    datetime updatedAt
  }

  File {
    uuid id PK
    uuid ownerId FK
    uuid folderId FK
    string name
    string originalName
    string mimeType
    bigint sizeBytes
    string storageKey UK
    string checksum
    datetime createdAt
    datetime updatedAt
  }

  UploadSession {
    uuid id PK
    uuid ownerId FK
    uuid folderId FK
    bigint sizeBytes
    string fileChecksum
    int chunkSizeBytes
    int totalChunks
    string status
    datetime expiresAt
  }

  UploadChunk {
    uuid id PK
    uuid uploadSessionId FK
    int chunkIndex
    int sizeBytes
    string checksum
  }
```

`Folder.parentId` and `File.folderId` are nullable for items at the drive root. Folder names are unique per owner and parent; the migration uses partial unique indexes to handle PostgreSQL `NULL` semantics at the root.

## Project layout

```text
apps/web             React client
apps/api/src         Fastify modular monolith
apps/api/prisma      schema and SQL migration
apps/api/uploads     local development object root
apps/api/tests       database-backed integration tests
packages/shared      transport DTOs and validation constants
```

## Local development

Requirements: Node.js 20+, npm, and PostgreSQL 15+.

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

The web app is at `http://localhost:5173`; the API is at `http://localhost:3000`. Prisma reads `DATABASE_URL` from the environment. For a host-run API, either export `.env` variables in the shell or run it with an environment loader.

## Docker

```bash
JWT_SECRET="replace-with-at-least-32-random-characters" docker compose up --build
```

Compose starts PostgreSQL with a healthcheck, waits before starting the API, applies committed migrations, and serves the frontend at `http://localhost:5173`. PostgreSQL and uploads use named volumes (`postgres_data`, `uploads_data`) and survive container recreation.

## Environment variables

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development`, `test`, or `production` |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT signing secret; at least 32 characters outside tests |
| `API_PORT` | API listen port, default `3000` |
| `WEB_ORIGIN` | Exact allowed browser CORS origin |
| `COOKIE_SECURE` | Set `true` behind production HTTPS |
| `JWT_SESSION_SECONDS` | JWT and cookie lifetime in seconds, default 604800 (7 days) |
| `CHUNK_SIZE_BYTES` | Server-selected chunk size, default 8388608 (8 MiB) |
| `UPLOAD_SESSION_TTL_SECONDS` | Resumable session lifetime, default 86400 (24 hours) |
| `MAX_FILE_SIZE_BYTES` | Per-file upload limit, default 5368709120 bytes (5 GiB) |
| `UPLOAD_ROOT` | Temporary/object storage root |
| `VITE_API_BASE_URL` | Browser-visible API origin, embedded at web build time |

Do not use the example or Compose fallback JWT secret in a real deployment.

## Database and migrations

Prisma models `User`, `Folder`, and `File` store accounts, hierarchy, and file metadata. Binary data is never placed in PostgreSQL. The initial migration includes partial unique indexes so root folders (whose `parentId` is `NULL`) also have per-user name uniqueness.

```bash
npm run prisma:migrate       # development migration workflow
npm run prisma:deploy -w @depot-drive/api  # apply committed migrations
```

## Tests and quality checks

Integration tests use a disposable, dedicated PostgreSQL database identified by `TEST_DATABASE_URL`. Never point it at a database containing useful data because tests clear application tables.

```bash
TEST_DATABASE_URL=postgresql://depot:depot@localhost:5432/depot_drive_test npm test
npm run typecheck
npm run build
```

Without `TEST_DATABASE_URL`, database integration tests are explicitly skipped rather than silently using the development database.

## API overview

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Create an account and session |
| POST | `/api/auth/login` | Create a session |
| GET | `/api/auth/me` | Current user |
| POST | `/api/auth/logout` | Clear session |
| GET/POST | `/api/folders` | List directory / create folder |
| PATCH/DELETE | `/api/folders/:folderId` | Rename / delete empty folder |
| GET | `/api/folders/:folderId/breadcrumbs` | Ancestor chain |
| POST | `/api/files/upload` | Multipart streamed upload (`folderId`, then `file`) |
| GET | `/api/files/:fileId/download` | Stream download |
| PATCH/DELETE | `/api/files/:fileId` | Rename metadata / delete file |
| GET | `/api/users/storage` | Current user's bytes used |
| GET | `/api/storage/nodes` | Node health, capacity, heartbeat, primary and replica counts |
| POST/GET | `/api/uploads` | Create-or-resume / list active upload sessions |
| GET/DELETE | `/api/uploads/:uploadId` | Get progress / cancel and clean a session |
| PUT | `/api/uploads/:uploadId/chunks/:chunkIndex` | Stream and verify one binary chunk |
| POST | `/api/uploads/:uploadId/complete` | Assemble, verify, and publish the file |

Errors consistently use `{ "error": { "code": "...", "message": "..." } }`.

## File storage design

Legacy uploads still stream into `uploads/tmp/<uuid>.part`. V0.2 chunks are independently verified and atomically stored at `uploads/sessions/<sessionId>/chunks/<index>`. Completion reads chunks in index order without loading the full file, validates final size and SHA-256, then atomically moves the assembled object to `uploads/objects/ab/cd/<uuid>`. Session directories are removed after completion, cancellation, or expiry.

## Security

- bcrypt cost 12 password hashing; normalized lowercase unique email
- JWT in `HttpOnly`, `SameSite=Lax` cookie; configurable `Secure`
- Exact-origin credentialed CORS and validated startup configuration
- Zod input validation, filename length/traversal checks, and multipart size limits
- Every resource lookup combines resource ID with authenticated owner ID
- Cross-user access receives 404, avoiding resource-existence disclosure
- Prisma parameterized queries and DTO mapping; password hashes/storage keys are not exposed
- Generic production errors, no client stack traces, streamed I/O, and interrupted temp cleanup
- MIME type is display/response metadata only and is not treated as trusted content classification

## Filesystem and Database Consistency

Chunk upload order is temporary chunk stream → size/checksum validation → atomic chunk move → chunk metadata insert. Completion atomically claims the session, streams chunks into an assembly temp file, validates it, then streams it to two distinct node roots. `File`, both `FileReplica` rows, and UploadSession removal are published in one database transaction. A failed transaction triggers deletion of both physical replicas and returns the session to ACTIVE; compensation deletion failures are logged with node and storage key.

New-file deletion attempts every replica before deleting metadata. If any node deletion fails, the API returns `REPLICA_DELETE_FAILED` and retains the File/FileReplica rows so the failure remains traceable and deletion can be retried. A replica deleted successfully before another fails is recorded as temporarily missing. Legacy V0.2 files retain force-delete behavior on `LocalFileStorage`. There is no cross-system transaction or orphan reconciliation job, so operators should back up PostgreSQL and the uploads volume together.

## Current limitations

- Single API node and local filesystem only
- Single file selection per task; no Range download, sharing, quotas, previews, search, or trash
- Folder deletion is empty-only and file deletion is permanent
- Cookies require an HTTPS reverse proxy plus `COOKIE_SECURE=true` in production
- Upload progress reports browser-to-server transfer progress, not post-upload database completion
- Pause/resume works while the page remains open. A refresh loses the browser `File` object, so the user must start again in this release; the server session and chunks remain available for a future same-file picker recovery flow.
- Storage nodes are local-directory implementations in one API process. V0.3.1 intentionally has no remote RPC, repair, rebalancing, consistent hashing, leader election, or consensus.
- A single API process owns all three simulated local nodes; stopping that process stops A, B, and C together. This is fault-path simulation, not three independent remote servers.
- Relative `UPLOAD_ROOT` values are resolved once against the monorepo workspace root, not the process working directory. The documented default is the absolute equivalent of `apps/api/uploads`.
- Download fallback covers node status, health, missing objects, and failures while opening a stream. Once response bytes have reached the client, a later stream failure cannot safely switch replicas in the same HTTP response; the client must retry the download.

## V0.3.1 distributed storage design

- Metadata Service owns file, node, and replica placement records in PostgreSQL
- Storage A/B/C use isolated filesystem roots and implement the transport-neutral `StorageNode` contract
- Every new file requires a PRIMARY and one REPLICA before metadata publication
- Heartbeats run every 10 seconds; metadata older than 30 seconds is marked DEAD
- Downloads skip DEAD/unhealthy/missing primary content and fall back to the replica

## V0.2 upload design

- Client-side incremental final SHA-256 calculation
- 8 MiB chunks and four concurrent upload workers
- Server-side UploadSession/UploadChunk persistence and missing-chunk discovery
- Per-chunk SHA-256, ordered streaming assembly, and final SHA-256 validation
- Independent pause/resume (server-authoritative missing-chunk reconciliation), explicit permanent cancellation, and startup/hourly expired-session cleanup
- Network and 5xx chunk retries use 500/1000/2000 ms backoff; 4xx responses are not retried

The legacy multipart endpoint and V0.2 files remain supported for backward compatibility. V0.3.1 adds local replica simulation without Redis, queues, distributed locks, S3, remote RPC, or storage-node consensus.
