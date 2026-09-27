ALTER TYPE "ReplicaStatus" ADD VALUE 'CORRUPT';
ALTER TYPE "StorageOperationType" ADD VALUE 'REPAIR_REPLICA';

ALTER TABLE "UploadSession"
  ADD COLUMN "clientUploadId" TEXT,
  ADD COLUMN "lastModified" BIGINT;

ALTER TABLE "FileReplica"
  ADD COLUMN "lastVerifiedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "UploadSession_ownerId_clientUploadId_key"
  ON "UploadSession"("ownerId", "clientUploadId");

CREATE INDEX "FileReplica_status_lastVerifiedAt_idx"
  ON "FileReplica"("status", "lastVerifiedAt");
