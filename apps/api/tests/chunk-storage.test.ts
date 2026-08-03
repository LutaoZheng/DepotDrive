import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFileStorage } from '../src/storage/local-file-storage.js';

const checksum=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
let root:string;let storage:LocalFileStorage;

describe('LocalFileStorage chunk lifecycle',()=>{
  beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'depot-chunks-'));storage=new LocalFileStorage(root)});
  afterEach(async()=>{await rm(root,{recursive:true,force:true})});

  it('validates chunks and assembles them in index order with final SHA-256',async()=>{const sessionId=randomUUID(),storageKey=randomUUID();const chunks=[Buffer.from('hello '),Buffer.from('chunked '),Buffer.from('world')];for(const[index,data]of chunks.entries())await storage.saveChunk({sessionId,chunkIndex:index,stream:Readable.from(data),expectedSizeBytes:data.length,expectedChecksum:checksum(data)});const expected=Buffer.concat(chunks);const stored=await storage.assembleChunks({sessionId,totalChunks:chunks.length,storageKey,expectedSizeBytes:expected.length,expectedChecksum:checksum(expected)});expect(stored).toEqual({storageKey,sizeBytes:expected.length,checksum:checksum(expected)});expect(await readFile(storage.pathFor(storageKey))).toEqual(expected)});
  it('rejects a bad chunk checksum without leaving a completed chunk',async()=>{const sessionId=randomUUID(),data=Buffer.from('corrupt');await expect(storage.saveChunk({sessionId,chunkIndex:0,stream:Readable.from(data),expectedSizeBytes:data.length,expectedChecksum:'0'.repeat(64)})).rejects.toThrow('CHUNK_CHECKSUM_MISMATCH');expect(await storage.chunkExists(sessionId,0)).toBe(false)});
  it('removes every temporary chunk when a session is cancelled',async()=>{const sessionId=randomUUID(),data=Buffer.from('cancel');await storage.saveChunk({sessionId,chunkIndex:0,stream:Readable.from(data),expectedSizeBytes:data.length,expectedChecksum:checksum(data)});await storage.deleteUploadSession(sessionId);expect(await storage.chunkExists(sessionId,0)).toBe(false)});
});
