import type { File as DbFile, Folder, User } from '@prisma/client';
import type { FileDto, FolderDto, UserDto } from '@depot-drive/shared';
export const userDto = (u: User): UserDto => ({ id:u.id,email:u.email,createdAt:u.createdAt.toISOString(),updatedAt:u.updatedAt.toISOString() });
export const folderDto = (f: Folder): FolderDto => ({ id:f.id,parentId:f.parentId,name:f.name,createdAt:f.createdAt.toISOString(),updatedAt:f.updatedAt.toISOString() });
export const fileDto = (f: DbFile): FileDto => ({ id:f.id,folderId:f.folderId,name:f.name,originalName:f.originalName,mimeType:f.mimeType,sizeBytes:Number(f.sizeBytes),checksum:f.checksum,createdAt:f.createdAt.toISOString(),updatedAt:f.updatedAt.toISOString() });
