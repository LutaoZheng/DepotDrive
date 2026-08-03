# DepotDrive V0.2

English | [简体中文](./README.zh-CN.md)

## Overview

DepotDrive is a self-hosted private cloud drive. V0.2 adds chunked, parallel, resumable uploads with per-chunk and final SHA-256 validation while retaining the single-node modular-monolith architecture.

## Features

- Register, sign in, sign out, and restore a cookie-based session
- Browse root and arbitrarily nested folders with breadcrumbs
- Create, rename, and delete empty folders
- Split files into 8 MiB chunks, upload up to four chunks in parallel, resume missing chunks, and cancel uploads
- Validate every chunk and the assembled file with SHA-256 before publishing metadata
- Stream downloads; rename display metadata; delete metadata and disk content
- Per-user storage totals, loading/error/empty states, and responsive Drive UI
- Owner-scoped resource lookups that return 404 for another user's resources

## Technology

React, TypeScript, Vite, Tailwind CSS, React Router, TanStack Query, and Axios power the web app. The modular-monolith API uses Node.js, Fastify, Prisma, PostgreSQL, JWT, bcrypt, Zod, and multipart streams. npm workspaces manage the monorepo; Docker Compose runs the full stack.

## Architecture

```mermaid
flowchart TD
  Web[React Web] --> API[Fastify API]
  API --> DB[(PostgreSQL Metadata)]
  API --> Storage[LocalFileStorage]
  Storage --> FS[(Local Filesystem)]
```

The HTTP routes delegate persistence to Prisma and binary operations to the `FileStorage` interface. `LocalFileStorage` remains the V0.2 implementation; a future storage client can replace it without putting filesystem calls in business routes.

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

Chunk upload order is temporary chunk stream → size/checksum validation → atomic chunk move → chunk metadata insert. Completion atomically claims the session, streams chunks into an assembly temp file, validates the final size/checksum, moves the object, then creates `File` metadata and deletes session metadata in one database transaction. An object is deleted if metadata publication fails, and the session returns to ACTIVE for retry.

Delete intentionally removes disk content first, then metadata. A missing disk object is accepted (`force` semantics), allowing damaged metadata to be cleaned up. A database outage after disk deletion can temporarily leave metadata pointing to missing content; a retry will again accept the missing object and remove metadata. V0.2 has no cross-system transaction, orphan-object reconciliation job, replication, or recovery journal. Operators should back up PostgreSQL and the uploads volume together.

## Current limitations

- Single API node and local filesystem only
- Single file selection per task; no Range download, sharing, quotas, previews, search, or trash
- Folder deletion is empty-only and file deletion is permanent
- Cookies require an HTTPS reverse proxy plus `COOKIE_SECURE=true` in production
- Upload progress reports browser-to-server transfer progress, not post-upload database completion
- Pause/resume works while the page remains open. A refresh loses the browser `File` object, so the user must start again in this release; the server session and chunks remain available for a future same-file picker recovery flow.

## V0.2 upload design

- Client-side incremental final SHA-256 calculation
- 8 MiB chunks and four concurrent upload workers
- Server-side UploadSession/UploadChunk persistence and missing-chunk discovery
- Per-chunk SHA-256, ordered streaming assembly, and final SHA-256 validation
- Independent pause/resume (server-authoritative missing-chunk reconciliation), explicit permanent cancellation, and startup/hourly expired-session cleanup
- Network and 5xx chunk retries use 500/1000/2000 ms backoff; 4xx responses are not retried

The legacy multipart endpoint remains supported for backward compatibility. V0.2 remains deliberately single-node: no Redis, queues, distributed locks, replicas, S3, or storage-node coordination.
