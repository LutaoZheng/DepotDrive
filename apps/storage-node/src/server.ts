import { buildStorageNode } from './app.js';

const port = Number(process.env.STORAGE_NODE_PORT ?? 4000);
const capacity = process.env.STORAGE_NODE_CAPACITY_BYTES ? Number(process.env.STORAGE_NODE_CAPACITY_BYTES) : undefined;
const config = {
  nodeId: process.env.STORAGE_NODE_ID ?? 'node-a',
  nodeName: process.env.STORAGE_NODE_NAME ?? 'Storage Node A',
  root: process.env.STORAGE_ROOT ?? '/data',
  internalToken: process.env.STORAGE_INTERNAL_TOKEN ?? '',
  capacityBytes: capacity,
  enableFaultInjection: process.env.ENABLE_FAULT_INJECTION === 'true',
};
if (!config.internalToken || config.internalToken.length < 32) throw new Error('STORAGE_INTERNAL_TOKEN must be at least 32 characters');
const app = buildStorageNode(config);
const shutdown = async (signal: string) => { app.log.info({ signal }, 'Shutting down'); await app.close(); process.exit(0); };
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
await app.listen({ port, host: '0.0.0.0' });
