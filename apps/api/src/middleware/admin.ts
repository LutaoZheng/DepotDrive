import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../plugins/prisma.js';

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const user = await prisma.user.findUnique({ where: { id: request.user.sub }, select: { role: true } });
  if (!user || user.role !== 'ADMIN') return reply.code(403).send({ error: { code: 'ADMIN_REQUIRED', message: 'Administrator access required' } });
}

export async function requireDemoAction(request: FastifyRequest, reply: FastifyReply) {
  if (!request.server.config.DEMO_MODE) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  if (request.headers.origin !== request.server.config.WEB_ORIGIN || request.headers['x-csrf-protection'] !== '1') {
    return reply.code(403).send({ error: { code: 'CSRF_REJECTED', message: 'Same-origin demo request required' } });
  }
}
