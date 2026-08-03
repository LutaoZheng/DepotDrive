import { mkdir, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { LocalFileStorage } from './local-file-storage.js';
import type { SaveFileInput } from './file-storage.js';
import type { StorageNode } from './storage-node.js';
import { once } from 'node:events';

async function directoryBytes(root: string): Promise<number> {
  let entries: Dirent[];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return 0; }
  let total = 0;
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

export class StorageNodeLocal implements StorageNode {
  private readonly storage: LocalFileStorage;
  constructor(readonly id: string, readonly name: string, private readonly root: string, private readonly capacityBytes: number) {
    this.storage = new LocalFileStorage(root);
  }
  upload(input: SaveFileInput) { return this.storage.save(input); }
  async download(storageKey: string) { const stream = this.storage.createReadStream(storageKey); await once(stream, 'open'); return stream; }
  delete(storageKey: string) { return this.storage.delete(storageKey); }
  exists(storageKey: string) { return this.storage.exists(storageKey); }
  async health() {
    try { await mkdir(this.root, { recursive: true }); return { alive: true, checkedAt: new Date() }; }
    catch { return { alive: false, checkedAt: new Date() }; }
  }
  async capacity() { return { capacityBytes: this.capacityBytes, usedBytes: await directoryBytes(path.join(this.root, 'objects')) }; }
}
