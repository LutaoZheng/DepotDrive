# Persistent Resumable Upload Design

## Identity

The browser computes the complete file SHA-256 before creating a session and derives:

```text
clientUploadId = sha256 : size : lastModified : name
```

The digest distinguishes same-name, same-size files with different contents. PostgreSQL enforces one identity per owner. A reused identity with mismatched metadata returns `409 UPLOAD_IDENTITY_CONFLICT`.

## Browser persistence

`localStorage` records only:

- client upload identity
- server upload session id
- file name, size, lastModified, and SHA-256
- last update time

Browsers do not reliably allow a `File` object to survive reload, so the user must reselect the file. Once selected, hashing confirms identity, the API returns the existing session, and the browser schedules only indexes absent from `completedChunks`.

## API restart

Upload session and chunk rows are PostgreSQL records. Chunk bodies live under the persistent API staging volume. Restarting the API changes neither. `POST /api/uploads` with the same identity returns the prior unexpired session.

## Duplicate clients

The chunk filesystem uses an atomic hard-link publish step. If two clients upload the same missing chunk concurrently:

- one publishes the file;
- the other verifies the already-published bytes;
- the database unique `(uploadSessionId, chunkIndex)` row chooses one winner;
- both identical requests succeed without duplicate state.

Finalization remains idempotent while `COMPLETING`; `File.uploadSessionId` is unique, preventing duplicate file records.

## Cleanup

Expired `ACTIVE` sessions are removed hourly by default. Cleanup deletes the session directory and cascades chunk metadata. It deliberately does not delete recent failed sessions, `COMPLETING` sessions with durable replica operations, or completed files.

## Limitations

- A user must reselect the same local file after reload.
- Hashing the whole file occurs before resume lookup; this is correctness-oriented and adds client CPU/time.
- API staging is a single-host persistent volume and can be a capacity bottleneck.
- There is no background upload from a closed browser.
