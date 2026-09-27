import { ReplicaRole, StorageNodeStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';

export async function storageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAdmin);
  app.get('/nodes', async () => {
    const nodes = await app.storageMetadata.dashboard();
    return { nodes: nodes.map(node => ({
      id: node.id,
      name: node.name,
      alive: node.status === StorageNodeStatus.HEALTHY,
      capacityBytes: Number(node.capacityBytes),
      usedBytes: Number(node.usedBytes),
      primaryCount: node.replicas.filter(replica => replica.role === ReplicaRole.PRIMARY).length,
      replicaCount: node.replicas.filter(replica => replica.role === ReplicaRole.REPLICA).length,
      lastHeartbeat: node.lastHeartbeatAt?.toISOString() ?? null,
    })) };
  });
}
