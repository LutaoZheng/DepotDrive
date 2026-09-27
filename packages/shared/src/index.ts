export const NAME_MAX_LENGTH = 255;
export const PASSWORD_MIN_LENGTH = 8;
export const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const MAX_PARALLEL_CHUNKS = 4;
export const MAX_UPLOAD_FILE_SIZE = 5 * 1024 * 1024 * 1024;

export type UserRole = 'USER' | 'ADMIN';
export interface UserDto { id: string; email: string; role: UserRole; createdAt: string; updatedAt: string }
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
  clientUploadId: string | null;
  lastModified: number | null;
  chunkSizeBytes: number;
  totalChunks: number;
  status: UploadSessionStatus;
  expiresAt: string;
  completedChunks: UploadChunkDto[];
}
export interface CreateUploadSessionRequest { folderId: string | null; name: string; mimeType: string; sizeBytes: number; fileChecksum: string; clientUploadId?: string; lastModified?: number }
export interface CreateUploadSessionResponse { upload: UploadSessionDto }
export interface StorageNodeDto { id: string; name: string; alive: boolean; capacityBytes: number; usedBytes: number; primaryCount: number; replicaCount: number; lastHeartbeat: string | null }
export interface StorageNodesResponse { nodes: StorageNodeDto[] }
export type MonitorStatus = 'HEALTHY' | 'UNAVAILABLE' | 'STALE' | 'DISCONNECTED';
export interface MonitorNodeDto { id: string; name: string; status: MonitorStatus; lastHeartbeatAt: string | null; capacityBytes: number; usedBytes: number; healthyReplicas: number; totalReplicas: number }
export interface MonitorEventDto { id: string; type: string; result: string; message: string; fileId: string | null; replicaId: string | null; nodeId: string | null; metadata: unknown; createdAt: string }
export interface MonitorReplicaDto { id: string; nodeId: string; nodeName: string; role: string; status: string; expectedSize: number; expectedSha256: string; lastVerifiedAt: string | null }
export interface MonitorFileDto { id: string; name: string; sizeBytes: number; checksum: string; status: string; createdAt: string; healthyReplicas: number; replicationFactor: number; replicas: MonitorReplicaDto[] }
export interface MonitorOverviewDto { generatedAt: string; coordinator: { status: MonitorStatus; database: MonitorStatus }; nodes: MonitorNodeDto[]; totals: { files: number; healthyReplicas: number; corruptReplicas: number; missingReplicas: number; unavailableReplicas: number; underReplicatedFiles: number; activeRepairs: number }; lastVerificationAt: string | null; lastScrubAt: string | null; recentEvents: MonitorEventDto[]; files: MonitorFileDto[]; demoActionsEnabled: boolean }
