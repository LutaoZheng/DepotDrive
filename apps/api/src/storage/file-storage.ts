import type { Readable } from 'node:stream';
export interface SaveFileInput { stream: Readable; storageKey: string }
export interface StoredFile { storageKey: string; sizeBytes: number; checksum: string }
export interface SaveChunkInput { sessionId: string; chunkIndex: number; stream: Readable; expectedSizeBytes: number; expectedChecksum: string }
export interface StoredChunk { chunkIndex: number; sizeBytes: number; checksum: string }
export interface AssembleChunksInput { sessionId: string; totalChunks: number; storageKey: string; expectedSizeBytes: number; expectedChecksum: string }
export interface FileStorage {
  save(input: SaveFileInput): Promise<StoredFile>;
  createReadStream(storageKey: string): NodeJS.ReadableStream;
  delete(storageKey: string): Promise<void>;
  exists(storageKey: string): Promise<boolean>;
  pathFor(storageKey: string): string;
  saveChunk(input: SaveChunkInput): Promise<StoredChunk>;
  chunkExists(sessionId: string, chunkIndex: number): Promise<boolean>;
  assembleChunks(input: AssembleChunksInput): Promise<StoredFile>;
  deleteUploadSession(sessionId: string): Promise<void>;
}
