import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { AssembleChunksInput, FileStorage, SaveChunkInput, SaveFileInput, StoredChunk, StoredFile } from './file-storage.js';

export class LocalFileStorage implements FileStorage {
  constructor(private root: string) {}
  private assertKey(key: string) { if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('Invalid storage key'); }
  private assertChunkIndex(index: number) { if (!Number.isInteger(index) || index < 0) throw new Error('Invalid chunk index'); }
  pathFor(key: string) { this.assertKey(key); return path.join(this.root, 'objects', key.slice(0,2), key.slice(2,4), key); }
  private sessionPath(sessionId: string) { this.assertKey(sessionId); return path.join(this.root, 'sessions', sessionId); }
  private chunkPath(sessionId: string, chunkIndex: number) { this.assertChunkIndex(chunkIndex); return path.join(this.sessionPath(sessionId), 'chunks', String(chunkIndex)); }
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
  async saveChunk({sessionId,chunkIndex,stream,expectedSizeBytes,expectedChecksum}:SaveChunkInput):Promise<StoredChunk>{
    const final=this.chunkPath(sessionId,chunkIndex);await mkdir(path.dirname(final),{recursive:true});const temp=`${final}.${randomUUID()}.part`;
    const hash=createHash('sha256');let sizeBytes=0;const meter=new Transform({transform(chunk,_enc,cb){sizeBytes+=chunk.length;hash.update(chunk);cb(null,chunk)}});
    try{await pipeline(stream,meter,createWriteStream(temp,{flags:'wx'}));const checksum=hash.digest('hex');if(sizeBytes!==expectedSizeBytes)throw new Error('CHUNK_SIZE_MISMATCH');if(checksum!==expectedChecksum.toLowerCase())throw new Error('CHUNK_CHECKSUM_MISMATCH');await rename(temp,final);return{chunkIndex,sizeBytes,checksum};}
    catch(error){await rm(temp,{force:true}).catch(()=>undefined);throw error;}
  }
  async chunkExists(sessionId:string,chunkIndex:number){try{await access(this.chunkPath(sessionId,chunkIndex));return true}catch{return false}}
  async assembleChunks({sessionId,totalChunks,storageKey,expectedSizeBytes,expectedChecksum}:AssembleChunksInput):Promise<StoredFile>{
    const final=this.pathFor(storageKey);await mkdir(path.dirname(final),{recursive:true});const temp=path.join(this.root,'tmp',`${storageKey}.assemble.part`);await mkdir(path.dirname(temp),{recursive:true});
    const output=createWriteStream(temp,{flags:'wx'});const hash=createHash('sha256');let sizeBytes=0;
    try{for(let index=0;index<totalChunks;index++){for await(const data of createReadStream(this.chunkPath(sessionId,index))){const chunk=Buffer.isBuffer(data)?data:Buffer.from(data);sizeBytes+=chunk.length;hash.update(chunk);if(!output.write(chunk))await once(output,'drain')}}output.end();await once(output,'finish');const checksum=hash.digest('hex');if(sizeBytes!==expectedSizeBytes)throw new Error('FILE_SIZE_MISMATCH');if(checksum!==expectedChecksum.toLowerCase())throw new Error('FILE_CHECKSUM_MISMATCH');await rename(temp,final);return{storageKey,sizeBytes,checksum};}
    catch(error){output.destroy();await rm(temp,{force:true}).catch(()=>undefined);throw error;}
  }
  async deleteUploadSession(sessionId:string){await rm(this.sessionPath(sessionId),{recursive:true,force:true})}
}
