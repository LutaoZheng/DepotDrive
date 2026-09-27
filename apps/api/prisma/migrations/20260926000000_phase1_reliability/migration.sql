ALTER TYPE "StorageNodeStatus" RENAME VALUE 'ALIVE' TO 'HEALTHY';
ALTER TYPE "StorageNodeStatus" RENAME VALUE 'DEAD' TO 'UNAVAILABLE';

CREATE TYPE "FileStatus" AS ENUM ('PENDING', 'AVAILABLE', 'DELETING');
CREATE TYPE "ReplicaStatus" AS ENUM ('PENDING', 'HEALTHY', 'MISSING', 'UNAVAILABLE', 'DELETE_PENDING');
CREATE TYPE "StorageOperationType" AS ENUM ('CREATE_REPLICA', 'DELETE_REPLICA');
CREATE TYPE "StorageOperationStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

ALTER TABLE "StorageNode" RENAME COLUMN "lastHeartbeat" TO "lastHeartbeatAt";
ALTER TABLE "StorageNode" ADD COLUMN "endpoint" TEXT NOT NULL DEFAULT '';
ALTER TABLE "StorageNode" ALTER COLUMN "endpoint" DROP DEFAULT;

DROP INDEX "StorageNode_status_lastHeartbeat_idx";
CREATE INDEX "StorageNode_status_lastHeartbeatAt_idx" ON "StorageNode"("status", "lastHeartbeatAt");

ALTER TABLE "File" ADD COLUMN "status" "FileStatus" NOT NULL DEFAULT 'AVAILABLE';
ALTER TABLE "File" ADD COLUMN "uploadSessionId" UUID;
CREATE UNIQUE INDEX "File_uploadSessionId_key" ON "File"("uploadSessionId");
ALTER TABLE "File" ADD CONSTRAINT "File_uploadSessionId_fkey" FOREIGN KEY ("uploadSessionId") REFERENCES "UploadSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FileReplica" ADD COLUMN "status" "ReplicaStatus" NOT NULL DEFAULT 'HEALTHY';
ALTER TABLE "FileReplica" ADD COLUMN "sizeBytes" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "FileReplica" ADD COLUMN "sha256" TEXT NOT NULL DEFAULT '';
ALTER TABLE "FileReplica" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "FileReplica" AS replica SET "sizeBytes" = file."sizeBytes", "sha256" = file."checksum" FROM "File" AS file WHERE replica."fileId" = file."id";
ALTER TABLE "FileReplica" ALTER COLUMN "sizeBytes" DROP DEFAULT;
ALTER TABLE "FileReplica" ALTER COLUMN "sha256" DROP DEFAULT;

CREATE TABLE "StorageOperation" (
  "id" UUID NOT NULL,
  "type" "StorageOperationType" NOT NULL,
  "status" "StorageOperationStatus" NOT NULL DEFAULT 'PENDING',
  "fileId" UUID NOT NULL,
  "replicaId" UUID NOT NULL,
  "storageNodeId" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorageOperation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StorageOperation_type_replicaId_key" ON "StorageOperation"("type", "replicaId");
CREATE INDEX "StorageOperation_status_updatedAt_idx" ON "StorageOperation"("status", "updatedAt");
CREATE INDEX "StorageOperation_fileId_status_idx" ON "StorageOperation"("fileId", "status");
ALTER TABLE "StorageOperation" ADD CONSTRAINT "StorageOperation_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorageOperation" ADD CONSTRAINT "StorageOperation_replicaId_fkey" FOREIGN KEY ("replicaId") REFERENCES "FileReplica"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorageOperation" ADD CONSTRAINT "StorageOperation_storageNodeId_fkey" FOREIGN KEY ("storageNodeId") REFERENCES "StorageNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
