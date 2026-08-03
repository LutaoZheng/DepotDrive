import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Prisma, UploadSessionStatus, type UploadChunk, type UploadSession } from '@prisma/client';
import type { CreateUploadSessionRequest, UploadSessionDto } from '@depot-drive/shared';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../plugins/prisma.js';
import type { FileStorage } from '../../storage/file-storage.js';
import { AppError } from '../../utils/errors.js';
import { fileDto } from '../../utils/dto.js';
import type { ReplicaService } from '../storage/replica-service.js';
import type { StorageMetadataService } from '../storage/metadata-service.js';

type SessionWithChunks = UploadSession & { chunks: UploadChunk[] };
const sha256Pattern = /^[a-f0-9]{64}$/i;

export function uploadSessionDto(session: SessionWithChunks): UploadSessionDto {
  return {
    id: session.id,
    folderId: session.folderId,
    name: session.name,
    mimeType: session.mimeType,
    sizeBytes: Number(session.sizeBytes),
    fileChecksum: session.fileChecksum,
    chunkSizeBytes: session.chunkSizeBytes,
    totalChunks: session.totalChunks,
    status: session.status,
    expiresAt: session.expiresAt.toISOString(),
    completedChunks: session.chunks.sort((a,b)=>a.chunkIndex-b.chunkIndex).map(chunk=>({chunkIndex:chunk.chunkIndex,sizeBytes:chunk.sizeBytes,checksum:chunk.checksum})),
  };
}

export class UploadService {
  constructor(private storage: FileStorage, private replicas: ReplicaService, private metadata: StorageMetadataService, private options: { chunkSizeBytes: number; maxFileSizeBytes: number; ttlSeconds: number }) {}

  private expiresAt() { return new Date(Date.now() + this.options.ttlSeconds * 1000); }
  private async ownedSession(id: string, ownerId: string) {
    const session=await prisma.uploadSession.findFirst({where:{id,ownerId},include:{chunks:true}});
    if(!session)throw new AppError(404,'UPLOAD_NOT_FOUND','Upload session not found');
    return session;
  }
  private ensureActive(session: UploadSession) {
    if(session.expiresAt<=new Date())throw new AppError(410,'UPLOAD_EXPIRED','Upload session has expired');
    if(session.status!==UploadSessionStatus.ACTIVE)throw new AppError(409,'UPLOAD_NOT_ACTIVE','Upload session is not active');
  }

  async create(ownerId:string,input:CreateUploadSessionRequest){
    if(input.folderId&&!await prisma.folder.findFirst({where:{id:input.folderId,ownerId}}))throw new AppError(404,'FOLDER_NOT_FOUND','Folder not found');
    if(input.sizeBytes<0||input.sizeBytes>this.options.maxFileSizeBytes)throw new AppError(413,'FILE_TOO_LARGE','File exceeds the maximum allowed size');
    if(!sha256Pattern.test(input.fileChecksum))throw new AppError(400,'INVALID_CHECKSUM','A valid SHA-256 checksum is required');
    const existing=await prisma.uploadSession.findFirst({where:{ownerId,folderId:input.folderId,name:input.name,sizeBytes:BigInt(input.sizeBytes),fileChecksum:input.fileChecksum.toLowerCase(),status:UploadSessionStatus.ACTIVE,expiresAt:{gt:new Date()}},include:{chunks:true},orderBy:{createdAt:'desc'}});
    if(existing)return uploadSessionDto(existing);
    const totalChunks=Math.ceil(input.sizeBytes/this.options.chunkSizeBytes);
    const session=await prisma.uploadSession.create({data:{ownerId,folderId:input.folderId,name:input.name,originalName:input.name,mimeType:input.mimeType||'application/octet-stream',sizeBytes:BigInt(input.sizeBytes),fileChecksum:input.fileChecksum.toLowerCase(),chunkSizeBytes:this.options.chunkSizeBytes,totalChunks,expiresAt:this.expiresAt()},include:{chunks:true}});
    return uploadSessionDto(session);
  }

  async list(ownerId:string){const sessions=await prisma.uploadSession.findMany({where:{ownerId,status:UploadSessionStatus.ACTIVE,expiresAt:{gt:new Date()}},include:{chunks:true},orderBy:{updatedAt:'desc'}});return sessions.map(uploadSessionDto)}
  async get(ownerId:string,id:string){return uploadSessionDto(await this.ownedSession(id,ownerId))}

  async saveChunk(ownerId:string,id:string,index:number,checksum:string,stream:Readable){
    const session=await this.ownedSession(id,ownerId);this.ensureActive(session);
    if(!Number.isInteger(index)||index<0||index>=session.totalChunks)throw new AppError(400,'INVALID_CHUNK_INDEX','Invalid chunk index');
    if(!sha256Pattern.test(checksum))throw new AppError(400,'INVALID_CHECKSUM','A valid chunk SHA-256 checksum is required');
    const expectedSize=index===session.totalChunks-1?Number(session.sizeBytes)-index*session.chunkSizeBytes:session.chunkSizeBytes;
    const existing=session.chunks.find(chunk=>chunk.chunkIndex===index);
    if(existing){stream.resume();if(existing.checksum===checksum.toLowerCase()&&existing.sizeBytes===expectedSize&&await this.storage.chunkExists(id,index))return existing;throw new AppError(409,'CHUNK_CONFLICT','Chunk already exists with different metadata');}
    let stored;
    try{stored=await this.storage.saveChunk({sessionId:id,chunkIndex:index,stream,expectedSizeBytes:expectedSize,expectedChecksum:checksum});}
    catch(error){const message=error instanceof Error?error.message:'';if(message==='CHUNK_SIZE_MISMATCH')throw new AppError(400,'CHUNK_SIZE_MISMATCH','Chunk size does not match');if(message==='CHUNK_CHECKSUM_MISMATCH')throw new AppError(422,'CHUNK_CHECKSUM_MISMATCH','Chunk checksum does not match');throw error;}
    try{return await prisma.uploadChunk.create({data:{uploadSessionId:id,chunkIndex:index,sizeBytes:stored.sizeBytes,checksum:stored.checksum}});}
    catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){const winner=await prisma.uploadChunk.findUnique({where:{uploadSessionId_chunkIndex:{uploadSessionId:id,chunkIndex:index}}});if(winner&&winner.checksum===stored.checksum)return winner;}throw error;}
  }

  async complete(ownerId:string,id:string){
    const session=await this.ownedSession(id,ownerId);this.ensureActive(session);
    if(session.chunks.length!==session.totalChunks)throw new AppError(409,'UPLOAD_INCOMPLETE','Not all chunks have been uploaded');
    for(let index=0;index<session.totalChunks;index++)if(!session.chunks.some(c=>c.chunkIndex===index)||!await this.storage.chunkExists(id,index))throw new AppError(409,'UPLOAD_INCOMPLETE',`Chunk ${index} is missing`);
    const claimed=await prisma.uploadSession.updateMany({where:{id,ownerId,status:UploadSessionStatus.ACTIVE},data:{status:UploadSessionStatus.COMPLETING,expiresAt:this.expiresAt()}});if(claimed.count!==1)throw new AppError(409,'UPLOAD_NOT_ACTIVE','Upload session is not active');
    const storageKey=randomUUID();
    try{
      const stored=await this.storage.assembleChunks({sessionId:id,totalChunks:session.totalChunks,storageKey,expectedSizeBytes:Number(session.sizeBytes),expectedChecksum:session.fileChecksum});
      const placements=await this.replicas.replicateFrom(this.storage,storageKey);
      try {
        const file=await prisma.$transaction(async tx=>{const created=await tx.file.create({data:{ownerId,folderId:session.folderId,name:session.name,originalName:session.originalName,mimeType:session.mimeType,sizeBytes:BigInt(stored.sizeBytes),storageKey,checksum:stored.checksum,replicas:{create:this.metadata.replicaCreateData(placements)}}});await tx.uploadSession.delete({where:{id}});return created;});
        await this.storage.delete(storageKey).catch(()=>undefined);await this.storage.deleteUploadSession(id).catch(()=>undefined);return fileDto(file);
      } catch(error) { await this.replicas.deletePlacements(placements); throw error; }
    }catch(error){await this.storage.delete(storageKey).catch(()=>undefined);await prisma.uploadSession.updateMany({where:{id,ownerId,status:UploadSessionStatus.COMPLETING},data:{status:UploadSessionStatus.ACTIVE,expiresAt:this.expiresAt()}}).catch(()=>undefined);const message=error instanceof Error?error.message:'';if(message==='FILE_SIZE_MISMATCH')throw new AppError(422,'FILE_SIZE_MISMATCH','Assembled file size does not match');if(message==='FILE_CHECKSUM_MISMATCH')throw new AppError(422,'FILE_CHECKSUM_MISMATCH','Final file checksum does not match');throw error;}
  }

  async cancel(ownerId:string,id:string){const session=await this.ownedSession(id,ownerId);if(session.status===UploadSessionStatus.COMPLETING)throw new AppError(409,'UPLOAD_COMPLETING','Upload is currently completing');await this.storage.deleteUploadSession(id);await prisma.uploadSession.delete({where:{id}})}
}

export async function cleanupExpiredUploads(storage:FileStorage,logger:FastifyBaseLogger){const expired=await prisma.uploadSession.findMany({where:{expiresAt:{lt:new Date()}},select:{id:true}});for(const session of expired){try{await storage.deleteUploadSession(session.id);await prisma.uploadSession.delete({where:{id:session.id}})}catch(error){logger.error({error,uploadSessionId:session.id},'Failed to clean expired upload session')}}return expired.length}
