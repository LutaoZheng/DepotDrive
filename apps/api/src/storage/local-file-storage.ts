import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileStorage, SaveFileInput, StoredFile } from './file-storage.js';

export class LocalFileStorage implements FileStorage {
  constructor(private root: string) {}
  private assertKey(key: string) { if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('Invalid storage key'); }
  pathFor(key: string) { this.assertKey(key); return path.join(this.root, 'objects', key.slice(0,2), key.slice(2,4), key); }
  async save({stream,storageKey}: SaveFileInput): Promise<StoredFile> {
    this.assertKey(storageKey);
    const tmpDir = path.join(this.root,'tmp'); await mkdir(tmpDir,{recursive:true});
    const temp = path.join(tmpDir,`${storageKey}.part`); const final = this.pathFor(storageKey);
    await mkdir(path.dirname(final),{recursive:true});
    const hash=createHash('sha256'); let sizeBytes=0;
    const meter=new Transform({transform(chunk,_enc,cb){ sizeBytes+=chunk.length; hash.update(chunk); cb(null,chunk); }});
    try { await pipeline(stream,meter,createWriteStream(temp,{flags:'wx'})); await rename(temp,final); return {storageKey,sizeBytes,checksum:hash.digest('hex')}; }
    catch (error) { await rm(temp,{force:true}).catch(()=>undefined); throw error; }
  }
  createReadStream(key: string) { return createReadStream(this.pathFor(key)); }
  async delete(key: string) { await rm(this.pathFor(key),{force:true}); }
  async exists(key: string) { try { await access(this.pathFor(key)); return true; } catch { return false; } }
}
