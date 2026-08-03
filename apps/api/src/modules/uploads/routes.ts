import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { fail } from '../../utils/errors.js';
import { safeName } from '../../utils/validation.js';
import { UploadService } from './service.js';

const sha256=z.string().regex(/^[a-f0-9]{64}$/i);
const createBody=z.object({folderId:z.string().uuid().nullable(),name:safeName,mimeType:z.string().max(255).default('application/octet-stream'),sizeBytes:z.number().int().nonnegative(),fileChecksum:sha256});
const sessionParams=z.object({uploadId:z.string().uuid()});const chunkParams=z.object({uploadId:z.string().uuid(),chunkIndex:z.coerce.number().int().nonnegative()});

export async function uploadRoutes(app:FastifyInstance){app.addHook('preHandler',authenticate);const service=new UploadService(app.storage,{chunkSizeBytes:app.config.CHUNK_SIZE_BYTES,maxFileSizeBytes:app.config.MAX_FILE_SIZE_BYTES,ttlSeconds:app.config.UPLOAD_SESSION_TTL_SECONDS});
 app.post('/',async(req,reply)=>{const parsed=createBody.safeParse(req.body);if(!parsed.success)return fail(reply,400,'VALIDATION_ERROR',parsed.error.issues[0]?.message??'Invalid upload');return reply.code(201).send({upload:await service.create(req.user.sub,parsed.data)});});
 app.get('/',async req=>({uploads:await service.list(req.user.sub)}));
 app.get('/:uploadId',async(req,reply)=>{const parsed=sessionParams.safeParse(req.params);if(!parsed.success)return fail(reply,400,'VALIDATION_ERROR','Invalid upload id');return{upload:await service.get(req.user.sub,parsed.data.uploadId)}});
 app.put('/:uploadId/chunks/:chunkIndex',{bodyLimit:app.config.CHUNK_SIZE_BYTES+1024},async(req,reply)=>{const parsed=chunkParams.safeParse(req.params),checksum=sha256.safeParse(req.headers['x-chunk-sha256']);if(!parsed.success||!checksum.success)return fail(reply,400,'VALIDATION_ERROR','Invalid chunk request');const body=req.body as Readable|undefined;if(!body||typeof body.pipe!=='function')return fail(reply,400,'CHUNK_REQUIRED','Chunk body is required');const chunk=await service.saveChunk(req.user.sub,parsed.data.uploadId,parsed.data.chunkIndex,checksum.data,body);return reply.code(200).send({chunk:{chunkIndex:chunk.chunkIndex,sizeBytes:chunk.sizeBytes,checksum:chunk.checksum}})});
 app.post('/:uploadId/complete',async(req,reply)=>{const parsed=sessionParams.safeParse(req.params);if(!parsed.success)return fail(reply,400,'VALIDATION_ERROR','Invalid upload id');return reply.send({file:await service.complete(req.user.sub,parsed.data.uploadId)})});
 app.delete('/:uploadId',async(req,reply)=>{const parsed=sessionParams.safeParse(req.params);if(!parsed.success)return fail(reply,400,'VALIDATION_ERROR','Invalid upload id');await service.cancel(req.user.sub,parsed.data.uploadId);return reply.code(204).send()});
}
