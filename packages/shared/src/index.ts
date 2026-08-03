export const NAME_MAX_LENGTH = 255;
export const PASSWORD_MIN_LENGTH = 8;
export const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const MAX_PARALLEL_CHUNKS = 4;
export const MAX_UPLOAD_FILE_SIZE = 5 * 1024 * 1024 * 1024;

export interface UserDto { id: string; email: string; createdAt: string; updatedAt: string }
export interface FolderDto { id: string; parentId: string | null; name: string; createdAt: string; updatedAt: string }
export interface FileDto { id: string; folderId: string | null; name: string; originalName: string; mimeType: string; sizeBytes: number; checksum: string; createdAt: string; updatedAt: string }
export interface DirectoryResponse { currentFolder: FolderDto | null; folders: FolderDto[]; files: FileDto[] }
export interface BreadcrumbDto { id: string; name: string }
export interface ErrorResponse { error: { code: string; message: string } }
export interface AuthResponse { user: UserDto }
export interface StorageUsageResponse { usedBytes: number }
export type UploadSessionStatus = 'ACTIVE' | 'COMPLETING';
export interface UploadChunkDto { chunkIndex: number; sizeBytes: number; checksum: string }
export interface UploadSessionDto {
  id: string;
  folderId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  fileChecksum: string;
  chunkSizeBytes: number;
  totalChunks: number;
  status: UploadSessionStatus;
  expiresAt: string;
  completedChunks: UploadChunkDto[];
}
export interface CreateUploadSessionRequest { folderId: string | null; name: string; mimeType: string; sizeBytes: number; fileChecksum: string }
export interface CreateUploadSessionResponse { upload: UploadSessionDto }
