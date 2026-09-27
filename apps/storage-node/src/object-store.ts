import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

export interface ObjectMetadata { sizeBytes: number; sha256: string }

function assertObjectKey(key: string) {
  if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('INVALID_OBJECT_KEY');
}

async function directoryBytes(root: string): Promise<number> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return 0; }
  let total = 0;
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile() && !entry.name.endsWith('.part') && !entry.name.endsWith('.metadata.json')) total += (await stat(target)).size;
  }
  return total;
}

export class ObjectStore {
  constructor(readonly root: string, private readonly configuredCapacityBytes?: number) {}

  pathFor(key: string) {
    assertObjectKey(key);
    return path.join(this.root, 'objects', key.slice(0, 2), key.slice(2, 4), key);
  }

  private metadataPath(key: string) { return `${this.pathFor(key)}.metadata.json`; }

  async verify(key: string): Promise<ObjectMetadata | null> {
    const target = this.pathFor(key);
    try {
      const info = await stat(target);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
      return { sizeBytes: info.size, sha256: hash.digest('hex') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async metadata(key: string): Promise<ObjectMetadata | null> {
    const target = this.pathFor(key);
    try {
      const info = await stat(target);
      try {
        const persisted = JSON.parse(await readFile(this.metadataPath(key), 'utf8')) as ObjectMetadata;
        if (persisted.sizeBytes === info.size && /^[a-f0-9]{64}$/.test(persisted.sha256)) return persisted;
      } catch { /* Rebuild metadata left incomplete by a crash or an older node version. */ }
      const verified = await this.verify(key);
      if (!verified) return null;
      await this.persistMetadata(key, verified);
      return verified;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async persistMetadata(key: string, metadata: ObjectMetadata) {
    const target = this.metadataPath(key);
    const temp = `${target}.${randomUUID()}.part`;
    await writeFile(temp, JSON.stringify(metadata), { flag: 'wx' });
    await rename(temp, target);
  }

  async put(key: string, stream: Readable, expected: ObjectMetadata, allowReplace = false): Promise<ObjectMetadata> {
    const existing = await this.verify(key);
    if (existing) {
      if (!allowReplace) {
        stream.resume();
        if (existing.sizeBytes === expected.sizeBytes && existing.sha256 === expected.sha256) return existing;
        throw new Error('OBJECT_CONFLICT');
      }
    }
    const final = this.pathFor(key);
    await mkdir(path.dirname(final), { recursive: true });
    const temp = `${final}.${randomUUID()}.part`;
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) { sizeBytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
    try {
      await pipeline(stream, meter, createWriteStream(temp, { flags: 'wx' }));
      const sha256 = hash.digest('hex');
      if (sizeBytes !== expected.sizeBytes) throw new Error('OBJECT_SIZE_MISMATCH');
      if (sha256 !== expected.sha256) throw new Error('OBJECT_CHECKSUM_MISMATCH');
      await rename(temp, final);
      await this.persistMetadata(key, { sizeBytes, sha256 });
      return { sizeBytes, sha256 };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  createReadStream(key: string) { return createReadStream(this.pathFor(key)); }
  async exists(key: string) { try { await access(this.pathFor(key)); return true; } catch { return false; } }
  async delete(key: string) { await Promise.all([rm(this.pathFor(key), { force: true }), rm(this.metadataPath(key), { force: true })]); }

  async corrupt(key: string) {
    const handle = await open(this.pathFor(key), 'r+');
    try {
      const byte = Buffer.alloc(1);
      const { bytesRead } = await handle.read(byte, 0, 1, 0);
      if (bytesRead === 0) await handle.write(Buffer.from([1]), 0, 1, 0);
      else { byte[0] = byte[0]! ^ 0xff; await handle.write(byte, 0, 1, 0); }
    } finally { await handle.close(); }
  }

  async health() {
    await mkdir(this.root, { recursive: true });
    const filesystem = await statfs(this.root);
    const filesystemCapacity = filesystem.blocks * filesystem.bsize;
    const capacityBytes = this.configuredCapacityBytes ?? filesystemCapacity;
    return { capacityBytes, usedBytes: await directoryBytes(path.join(this.root, 'objects')) };
  }
}
