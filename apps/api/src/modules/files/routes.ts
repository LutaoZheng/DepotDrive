import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../plugins/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { fileDto } from '../../utils/dto.js';
import { fail } from '../../utils/errors.js';
import { safeName } from '../../utils/validation.js';

const params=z.object({fileId:z.string().uuid()});
const rename=z.object({name:safeName});
const owned=(fileId:string,ownerId:string)=>prisma.file.findFirst({where:{id:fileId,ownerId}});
function contentDisposition(name:string){return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`;}

export async function fileRoutes(app:FastifyInstance){app.addHook('preHandler',authenticate);
 app.post('/upload',async(req,reply)=>{const part=await req.file();if(!part)return fail(reply,400,'FILE_REQUIRED','A file is required');
   const rawFolder=part.fields.folderId; const folderId=rawFolder&&'value' in rawFolder&&String(rawFolder.value).trim()?String(rawFolder.value):null;
   if(folderId&&!z.string().uuid().safeParse(folderId).success){part.file.resume();return fail(reply,400,'VALIDATION_ERROR','Invalid folderId');}
   if(folderId&&!await prisma.folder.findFirst({where:{id:folderId,ownerId:req.user.sub}})){part.file.resume();return fail(reply,404,'FOLDER_NOT_FOUND','Folder not found');}
   const parsedName=safeName.safeParse(part.filename);if(!parsedName.success){part.file.resume();return fail(reply,400,'INVALID_FILE_NAME','Invalid file name');}
   const storageKey=randomUUID();let stored;
   try{stored=await app.storage.save({stream:part.file,storageKey});if(part.file.truncated){await app.storage.delete(storageKey);return fail(reply,413,'FILE_TOO_LARGE','File exceeds the maximum allowed size');}}
   catch(e){if(part.file.truncated)return fail(reply,413,'FILE_TOO_LARGE','File exceeds the maximum allowed size');throw e;}
   try{const file=await prisma.file.create({data:{ownerId:req.user.sub,folderId,name:parsedName.data,originalName:parsedName.data,mimeType:part.mimetype||'application/octet-stream',sizeBytes:BigInt(stored.sizeBytes),storageKey,checksum:stored.checksum}});return reply.code(201).send(fileDto(file));}
   catch(e){await app.storage.delete(storageKey).catch(err=>req.log.error(err,'Failed upload compensation'));throw e;}
 });
 app.get('/:fileId/download',async(req,reply)=>{const p=params.safeParse(req.params);if(!p.success)return fail(reply,400,'VALIDATION_ERROR','Invalid file id');const file=await owned(p.data.fileId,req.user.sub);if(!file)return fail(reply,404,'FILE_NOT_FOUND','File not found');if(!await app.storage.exists(file.storageKey))return fail(reply,404,'FILE_CONTENT_MISSING','File content is missing');reply.header('Content-Type',file.mimeType).header('Content-Length',file.sizeBytes.toString()).header('Content-Disposition',contentDisposition(file.name));return reply.send(app.storage.createReadStream(file.storageKey));});
 app.patch('/:fileId',async(req,reply)=>{const p=params.safeParse(req.params),b=rename.safeParse(req.body);if(!p.success||!b.success)return fail(reply,400,'VALIDATION_ERROR','Invalid request');const file=await owned(p.data.fileId,req.user.sub);if(!file)return fail(reply,404,'FILE_NOT_FOUND','File not found');return fileDto(await prisma.file.update({where:{id:file.id},data:{name:b.data.name}}));});
 app.delete('/:fileId',async(req,reply)=>{const p=params.safeParse(req.params);if(!p.success)return fail(reply,400,'VALIDATION_ERROR','Invalid file id');const file=await owned(p.data.fileId,req.user.sub);if(!file)return fail(reply,404,'FILE_NOT_FOUND','File not found');
   // Disk first prevents metadata from pointing at deliberately deleted content. Missing disk data is accepted; DB deletion remains possible.
   await app.storage.delete(file.storageKey);await prisma.file.delete({where:{id:file.id}});return reply.code(204).send();});
}
