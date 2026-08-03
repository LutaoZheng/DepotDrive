import type { Readable } from 'node:stream';
import type { SaveFileInput, StoredFile } from './file-storage.js';

export interface StorageNodeHealth { alive: boolean; checkedAt: Date }
export interface StorageNodeCapacity { capacityBytes: number; usedBytes: number }

/** Transport-neutral object storage boundary. A future remote implementation can use HTTP or gRPC. */
export interface StorageNode {
  readonly id: string;
  readonly name: string;
  upload(input: SaveFileInput): Promise<StoredFile>;
  download(storageKey: string): Promise<Readable>;
  delete(storageKey: string): Promise<void>;
  exists(storageKey: string): Promise<boolean>;
  health(): Promise<StorageNodeHealth>;
  capacity(): Promise<StorageNodeCapacity>;
}
