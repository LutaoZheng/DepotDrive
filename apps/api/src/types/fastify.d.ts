import '@fastify/jwt';
import 'fastify';
import type { Env } from '../config/env.js';
import type { FileStorage } from '../storage/file-storage.js';
import type { StorageNodeRegistry } from '../storage/storage-node-registry.js';
import type { StorageMetadataService } from '../modules/storage/metadata-service.js';
import type { ReplicaService } from '../modules/storage/replica-service.js';
import type { StorageOperationService } from '../modules/storage/operation-service.js';
import type { IntegrityService } from '../modules/storage/integrity-service.js';
import type { ScrubService } from '../modules/storage/scrub-service.js';
declare module '@fastify/jwt' { interface FastifyJWT { payload: { sub: string; email: string }; user: { sub: string; email: string } } }
declare module 'fastify' { interface FastifyInstance { config: Env; storage: FileStorage; storageNodes: StorageNodeRegistry; storageMetadata: StorageMetadataService; integrity: IntegrityService; storageOperations: StorageOperationService; scrubber: ScrubService; replicas: ReplicaService } }
