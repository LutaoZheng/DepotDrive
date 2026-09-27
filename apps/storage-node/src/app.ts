import Fastify from 'fastify';
import type { Readable } from 'node:stream';
import { ObjectStore } from './object-store.js';

export interface StorageNodeConfig {
  nodeId: string;
  nodeName: string;
  root: string;
  internalToken: string;
  capacityBytes?: number;
  enableFaultInjection?: boolean;
}

const objectKeyPattern = /^[0-9a-f-]{36}$/i;
const sha256Pattern = /^[a-f0-9]{64}$/i;

export function buildStorageNode(config: StorageNodeConfig, logger = config.nodeId !== 'test') {
  const app = Fastify({ logger, bodyLimit: 6 * 1024 * 1024 * 1024 });
  const store = new ObjectStore(config.root, config.capacityBytes);
  let failNextPuts = 0;
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${config.internalToken}`) return reply.code(401).send({ error: 'UNAUTHORIZED' });
  });
  app.get('/health', async () => ({ nodeId: config.nodeId, name: config.nodeName, status: 'HEALTHY', ...(await store.health()) }));
  if (config.enableFaultInjection) app.post('/internal/faults', async (request) => {
    const requested = Number((request.body as { failNextPuts?: number } | undefined)?.failNextPuts ?? 0);
    failNextPuts = Number.isInteger(requested) && requested >= 0 ? requested : 0;
    return { failNextPuts };
  });
  if (config.enableFaultInjection) app.post('/internal/objects/:objectKey/corrupt', async (request, reply) => {
    const { objectKey } = request.params as { objectKey: string };
    if (!objectKeyPattern.test(objectKey)) return reply.code(400).send({ error: 'INVALID_OBJECT_KEY' });
    if (!await store.exists(objectKey)) return reply.code(404).send({ error: 'OBJECT_NOT_FOUND' });
    await store.corrupt(objectKey);
    return { corrupted: true };
  });
  app.head('/objects/:objectKey', async (request, reply) => {
    const { objectKey } = request.params as { objectKey: string };
    if (!objectKeyPattern.test(objectKey)) return reply.code(400).send();
    const metadata = await store.metadata(objectKey);
    if (!metadata) return reply.code(404).send();
    return reply.header('Content-Length', metadata.sizeBytes).header('X-Object-SHA256', metadata.sha256).code(200).send();
  });
  app.put('/objects/:objectKey', async (request, reply) => {
    const { objectKey } = request.params as { objectKey: string };
    const expectedSize = Number(request.headers['x-object-size']);
    const expectedChecksum = String(request.headers['x-object-sha256'] ?? '').toLowerCase();
    if (!objectKeyPattern.test(objectKey) || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || !sha256Pattern.test(expectedChecksum)) return reply.code(400).send({ error: 'INVALID_OBJECT_METADATA' });
    if (failNextPuts > 0) { failNextPuts--; request.raw.resume(); return reply.code(503).send({ error: 'INJECTED_WRITE_FAILURE' }); }
    try {
      const metadata = await store.put(objectKey, request.body as Readable, { sizeBytes: expectedSize, sha256: expectedChecksum }, request.headers['x-allow-replace'] === 'true');
      return reply.code(200).send(metadata);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'OBJECT_CONFLICT') return reply.code(409).send({ error: code });
      if (code === 'OBJECT_SIZE_MISMATCH' || code === 'OBJECT_CHECKSUM_MISMATCH') return reply.code(422).send({ error: code });
      throw error;
    }
  });
  app.get('/objects/:objectKey', async (request, reply) => {
    const { objectKey } = request.params as { objectKey: string };
    if (!objectKeyPattern.test(objectKey)) return reply.code(400).send();
    const metadata = await store.metadata(objectKey);
    if (!metadata) return reply.code(404).send();
    reply.header('Content-Length', metadata.sizeBytes).header('X-Object-SHA256', metadata.sha256).header('Content-Type', 'application/octet-stream');
    return reply.send(store.createReadStream(objectKey));
  });
  app.delete('/objects/:objectKey', async (request, reply) => {
    const { objectKey } = request.params as { objectKey: string };
    if (!objectKeyPattern.test(objectKey)) return reply.code(400).send();
    await store.delete(objectKey);
    return reply.code(204).send();
  });
  return app;
}
