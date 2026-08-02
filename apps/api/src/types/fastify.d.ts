import '@fastify/jwt';
import 'fastify';
import type { Env } from '../config/env.js';
import type { FileStorage } from '../storage/file-storage.js';
declare module '@fastify/jwt' { interface FastifyJWT { payload: { sub: string; email: string }; user: { sub: string; email: string } } }
declare module 'fastify' { interface FastifyInstance { config: Env; storage: FileStorage } }
