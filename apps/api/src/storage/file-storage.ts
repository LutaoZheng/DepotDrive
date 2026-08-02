import type { Readable } from 'node:stream';
export interface SaveFileInput { stream: Readable; storageKey: string }
export interface StoredFile { storageKey: string; sizeBytes: number; checksum: string }
export interface FileStorage {
  save(input: SaveFileInput): Promise<StoredFile>;
  createReadStream(storageKey: string): NodeJS.ReadableStream;
  delete(storageKey: string): Promise<void>;
  exists(storageKey: string): Promise<boolean>;
  pathFor(storageKey: string): string;
}
