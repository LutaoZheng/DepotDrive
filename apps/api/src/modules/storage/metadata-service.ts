import { ReplicaRole, StorageNodeStatus } from '@prisma/client';
import { prisma } from '../../plugins/prisma.js';
import type { StorageNodeRegistry } from '../../storage/storage-node-registry.js';
import { chooseReplicaNodes } from './placement.js';
import { recordStorageEvent } from './event-service.js';

export const isHeartbeatFresh = (lastHeartbeat: Date | null, now: Date, timeoutMs: number) => Boolean(lastHeartbeat && now.getTime() - lastHeartbeat.getTime() <= timeoutMs);

export class StorageMetadataService {
  constructor(private readonly failureTimeoutMs: number) {}

  async recordHeartbeat(nodeId: string, name: string, endpoint: string, alive: boolean, capacityBytes: number, usedBytes: number, at = new Date()) {
    const previous = await prisma.storageNode.findUnique({ where: { id: nodeId }, select: { status: true } });
    const node = await prisma.storageNode.upsert({
      where: { id: nodeId },
      create: { id: nodeId, name, endpoint, status: alive ? StorageNodeStatus.HEALTHY : StorageNodeStatus.UNAVAILABLE, capacityBytes: BigInt(capacityBytes), usedBytes: BigInt(usedBytes), lastHeartbeatAt: alive ? at : null },
      update: { name, endpoint, status: alive ? StorageNodeStatus.HEALTHY : StorageNodeStatus.UNAVAILABLE, capacityBytes: BigInt(capacityBytes), usedBytes: BigInt(usedBytes), ...(alive ? { lastHeartbeatAt: at } : {}) },
    });
    if (previous && previous.status !== node.status) await recordStorageEvent({
      type: node.status === StorageNodeStatus.HEALTHY ? 'NODE_RECOVERED' : 'NODE_UNAVAILABLE', result: node.status === StorageNodeStatus.HEALTHY ? 'SUCCESS' : 'FAILURE', nodeId,
      message: `${name} transitioned to ${node.status}`,
    }).catch(() => undefined);
    return node;
  }

  async markStaleDead(now = new Date()) {
    const cutoff = new Date(now.getTime() - this.failureTimeoutMs);
    return prisma.storageNode.updateMany({ where: { status: StorageNodeStatus.HEALTHY, OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: cutoff } }] }, data: { status: StorageNodeStatus.UNAVAILABLE } });
  }

  async chooseNodes(count = 2, now = new Date()) {
    await this.markStaleDead(now);
    const cutoff = new Date(now.getTime() - this.failureTimeoutMs);
    const nodes = await prisma.storageNode.findMany({
      where: { status: StorageNodeStatus.HEALTHY, lastHeartbeatAt: { gte: cutoff } },
      include: { replicas: { where: { role: ReplicaRole.PRIMARY }, select: { id: true } } },
    });
    return chooseReplicaNodes(nodes.map(node => ({ id: node.id, usedBytes: node.usedBytes, capacityBytes: node.capacityBytes, primaryCount: node.replicas.length })), count);
  }

  async dashboard(now = new Date()) {
    await this.markStaleDead(now);
    return prisma.storageNode.findMany({ include: { _count: { select: { replicas: true } }, replicas: { where: { status: 'HEALTHY' }, select: { role: true } } }, orderBy: { name: 'asc' } });
  }

  async refreshRegistry(registry: StorageNodeRegistry) {
    await Promise.all(registry.all().map(async node => {
      const health = await node.health();
      if (!health.alive) {
        const existing = await prisma.storageNode.findUnique({ where: { id: node.id } });
        await this.recordHeartbeat(node.id, node.name, node.endpoint, false, Number(existing?.capacityBytes ?? 1n), Number(existing?.usedBytes ?? 0n), health.checkedAt);
        return;
      }
      const capacity = await node.capacity();
      await this.recordHeartbeat(node.id, node.name, node.endpoint, true, capacity.capacityBytes, capacity.usedBytes, health.checkedAt);
    }));
  }
}
