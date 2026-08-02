import type { FastifyReply } from 'fastify';
export function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
export class AppError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
