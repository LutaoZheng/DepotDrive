CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

ALTER TABLE "User"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';

CREATE TABLE "SystemEvent" (
  "id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "fileId" UUID,
  "replicaId" UUID,
  "nodeId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SystemEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SystemEvent_createdAt_idx" ON "SystemEvent"("createdAt");
CREATE INDEX "SystemEvent_fileId_createdAt_idx" ON "SystemEvent"("fileId", "createdAt");
CREATE INDEX "SystemEvent_nodeId_createdAt_idx" ON "SystemEvent"("nodeId", "createdAt");
