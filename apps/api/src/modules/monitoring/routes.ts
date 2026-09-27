import { ReplicaStatus, StorageNodeStatus, StorageOperationStatus, StorageOperationType } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import { requireAdmin, requireDemoAction } from '../../middleware/admin.js';
import { prisma } from '../../plugins/prisma.js';
import { recordStorageEvent } from '../storage/event-service.js';

const eventDto = (event: Awaited<ReturnType<typeof prisma.systemEvent.findFirstOrThrow>>) => ({ ...event, createdAt: event.createdAt.toISOString() });

export async function monitoringRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAdmin);

  app.get('/overview', async () => {
    let database: 'HEALTHY' | 'DISCONNECTED' = 'HEALTHY';
    try { await prisma.$queryRaw`SELECT 1`; } catch { database = 'DISCONNECTED'; }
    const [nodes, files, fileHealth, events, activeRepairs, lastVerification, lastScrub] = await Promise.all([
      prisma.storageNode.findMany({ include: { replicas: { select: { status: true } } }, orderBy: { name: 'asc' } }),
      prisma.file.findMany({ where: { status: 'AVAILABLE' }, include: { replicas: { include: { node: { select: { name: true, status: true } } } } }, orderBy: { createdAt: 'desc' }, take: 25 }),
      prisma.file.findMany({ where: { status: 'AVAILABLE' }, select: { replicas: { select: { status: true, node: { select: { status: true } } } } } }),
      prisma.systemEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }),
      prisma.storageOperation.count({ where: { type: StorageOperationType.REPAIR_REPLICA, status: { in: [StorageOperationStatus.PENDING, StorageOperationStatus.RUNNING] } } }),
      prisma.fileReplica.findFirst({ where: { lastVerifiedAt: { not: null } }, orderBy: { lastVerifiedAt: 'desc' }, select: { lastVerifiedAt: true } }),
      prisma.systemEvent.findFirst({ where: { type: 'SCRUB_COMPLETED' }, orderBy: { createdAt: 'desc' } }),
    ]);
    const now = Date.now();
    const monitorNodes = nodes.map(node => {
      const stale = !node.lastHeartbeatAt || now - node.lastHeartbeatAt.getTime() > app.config.STORAGE_FAILURE_TIMEOUT_MS;
      return {
        id: node.id, name: node.name,
        status: node.status === StorageNodeStatus.UNAVAILABLE ? 'UNAVAILABLE' as const : stale ? 'STALE' as const : 'HEALTHY' as const,
        lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
        capacityBytes: Number(node.capacityBytes), usedBytes: Number(node.usedBytes),
        healthyReplicas: node.replicas.filter(replica => replica.status === ReplicaStatus.HEALTHY).length,
        totalReplicas: node.replicas.length,
      };
    });
    const monitorFiles = files.map(file => {
      const replicas = file.replicas.map(replica => ({
        id: replica.id, nodeId: replica.nodeId, nodeName: replica.node.name, role: replica.role, status: replica.status,
        expectedSize: Number(replica.sizeBytes), expectedSha256: replica.sha256, lastVerifiedAt: replica.lastVerifiedAt?.toISOString() ?? null,
      }));
      return { id: file.id, name: file.name, sizeBytes: Number(file.sizeBytes), checksum: file.checksum, status: file.status, createdAt: file.createdAt.toISOString(), healthyReplicas: file.replicas.filter(replica => replica.status === ReplicaStatus.HEALTHY && replica.node.status === StorageNodeStatus.HEALTHY).length, replicationFactor: 2, replicas };
    });
    return {
      generatedAt: new Date().toISOString(), coordinator: { status: 'HEALTHY' as const, database }, nodes: monitorNodes,
      totals: {
        files: await prisma.file.count({ where: { status: 'AVAILABLE' } }),
        healthyReplicas: await prisma.fileReplica.count({ where: { status: ReplicaStatus.HEALTHY } }),
        corruptReplicas: await prisma.fileReplica.count({ where: { status: ReplicaStatus.CORRUPT } }),
        missingReplicas: await prisma.fileReplica.count({ where: { status: ReplicaStatus.MISSING } }),
        unavailableReplicas: await prisma.fileReplica.count({ where: { status: ReplicaStatus.UNAVAILABLE } }),
        underReplicatedFiles: fileHealth.filter(file => file.replicas.filter(replica => replica.status === ReplicaStatus.HEALTHY && replica.node.status === StorageNodeStatus.HEALTHY).length < 2).length,
        activeRepairs,
      },
      lastVerificationAt: lastVerification?.lastVerifiedAt?.toISOString() ?? null,
      lastScrubAt: lastScrub?.createdAt.toISOString() ?? null,
      recentEvents: events.map(eventDto), files: monitorFiles, demoActionsEnabled: app.config.DEMO_MODE,
    };
  });

  app.post('/actions/scrub', { preHandler: requireDemoAction }, async () => {
    const result = await app.scrubber.tick(app.config.SCRUB_BATCH_SIZE);
    return { action: 'SCRUB', ...result };
  });

  app.post('/actions/repair', { preHandler: requireDemoAction }, async () => {
    const processed = await app.storageOperations.reconcileRepairs(0, app.config.REPAIR_BATCH_SIZE);
    await recordStorageEvent({ type: 'REPAIR_TRIGGERED', result: 'INFO', message: `Manual demo repair pass processed ${processed} operation(s)`, metadata: { processed } });
    return { action: 'REPAIR', processed };
  });
}
