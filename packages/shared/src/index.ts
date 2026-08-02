export const NAME_MAX_LENGTH = 255;
export const PASSWORD_MIN_LENGTH = 8;

export interface UserDto { id: string; email: string; createdAt: string; updatedAt: string }
export interface FolderDto { id: string; parentId: string | null; name: string; createdAt: string; updatedAt: string }
export interface FileDto { id: string; folderId: string | null; name: string; originalName: string; mimeType: string; sizeBytes: number; checksum: string; createdAt: string; updatedAt: string }
export interface DirectoryResponse { currentFolder: FolderDto | null; folders: FolderDto[]; files: FileDto[] }
export interface BreadcrumbDto { id: string; name: string }
export interface ErrorResponse { error: { code: string; message: string } }
export interface AuthResponse { user: UserDto }
export interface StorageUsageResponse { usedBytes: number }
