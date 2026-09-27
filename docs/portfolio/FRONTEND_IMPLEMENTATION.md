# Final Frontend Implementation

## Delivered product surface

The React application now has four authenticated product routes:

- `/login` and `/register`: real cookie-session authentication, validation, loading and API error states.
- `/drive`: file/folder browser, multi-file upload queue, download, rename, confirmed delete, usage, empty/loading/error states, and a file-details dialog.
- `/monitor`: administrator-only live Coordinator, PostgreSQL, Storage Node, replica, repair and scrub state.
- `/reliability`: administrator-only topology, real per-file replica state, persisted operation timeline, and narrow demo actions.

`apps/web/src/components/AppShell.tsx`, `StatusBadge.tsx`, and `apps/web/src/index.css` provide the responsive design language, keyboard focus treatment, status vocabulary, navigation, cards, tables, dialogs, skeletons and mobile layouts.

## Upload manager

`apps/web/src/components/UploadManager.tsx` uses the existing `apps/web/src/chunked-upload.ts` pipeline; it is not a second uploader. It supports multiple files, two queued files concurrently, and up to four chunk workers per file. Each job exposes real bytes, chunks, active workers, measured throughput, pause, resume, cancel and retry.

The browser hashes the file, derives a content-aware identity from SHA-256/name/size/lastModified, and stores only session metadata in `localStorage`. After refresh, the user must reselect the original `File`; the client then reuses the server session and fetches completed chunks before scheduling only missing indexes. The `File` bytes are intentionally not persisted in browser storage.

## Monitoring and authorization

`GET /api/monitoring/overview` is protected by the normal authenticated session plus the persisted Prisma `User.role = ADMIN`. It derives all values from PostgreSQL and live Coordinator state. A failed poll visibly changes previously green components to `DISCONNECTED` rather than retaining stale success.

The new `SystemEvent` table records real heartbeat transitions, verification failures, download fallback, repair start/completion/failure and scrub completion. The timeline is therefore durable and is not driven by frontend timers.

`POST /api/monitoring/actions/scrub` and `/repair` exist only when `DEMO_MODE=true`. They require ADMIN, an exact same-origin check, and `X-CSRF-Protection: 1`. Production Compose does not enable demo mode. Docker lifecycle and byte corruption remain CLI-only: neither Web nor API mounts the Docker socket or accepts arbitrary commands.

## Core changed files

- Web: `apps/web/src/App.tsx`, `pages/DrivePage.tsx`, `pages/AuthPage.tsx`, `pages/StorageDashboardPage.tsx`, `pages/ReliabilityDemoPage.tsx`, `components/UploadManager.tsx`, `chunked-upload.ts`, `monitoring.ts`, `index.css`.
- API: `modules/monitoring/routes.ts`, `middleware/admin.ts`, `modules/storage/event-service.ts`, storage heartbeat/integrity/repair/scrub services, `app.ts`, `server.ts`.
- Data: `apps/api/prisma/schema.prisma` and migration `20260928000000_portfolio_monitoring`.
- Verification: `e2e/portfolio.spec.ts`, `playwright.config.ts`, `scripts/test-e2e.sh`.

## Security boundaries

Ordinary users cannot see monitoring routes, replica identifiers, object keys, node endpoints, or failure controls. The user-facing file dialog exposes only name, size, upload time, MIME type, availability and SHA-256. Local demo credentials are bootstrapped only by the opt-in demo override and should be replaced through environment variables outside a local demonstration.

