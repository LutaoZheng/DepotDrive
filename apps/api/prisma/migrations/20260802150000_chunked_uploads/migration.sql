CREATE TYPE "UploadSessionStatus" AS ENUM ('ACTIVE', 'COMPLETING');

CREATE TABLE "UploadSession" (
  "id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "folderId" UUID,
  "name" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "fileChecksum" TEXT NOT NULL,
  "chunkSizeBytes" INTEGER NOT NULL,
  "totalChunks" INTEGER NOT NULL,
  "status" "UploadSessionStatus" NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UploadChunk" (
  "id" UUID NOT NULL,
  "uploadSessionId" UUID NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "checksum" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UploadChunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UploadSession_ownerId_expiresAt_idx" ON "UploadSession"("ownerId", "expiresAt");
CREATE INDEX "UploadSession_expiresAt_idx" ON "UploadSession"("expiresAt");
CREATE UNIQUE INDEX "UploadChunk_uploadSessionId_chunkIndex_key" ON "UploadChunk"("uploadSessionId", "chunkIndex");
CREATE INDEX "UploadChunk_uploadSessionId_idx" ON "UploadChunk"("uploadSessionId");
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UploadChunk" ADD CONSTRAINT "UploadChunk_uploadSessionId_fkey" FOREIGN KEY ("uploadSessionId") REFERENCES "UploadSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
