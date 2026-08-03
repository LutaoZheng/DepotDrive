import { ReplicaRole, StorageNodeStatus, type Prisma } from '@prisma/client';
import { prisma } from '../../plugins/prisma.js';
import type { StorageNodeRegistry } from '../../storage/storage-node-registry.js';
import { chooseReplicaNodes } from './placement.js';

export const isHeartbeatFresh = (lastHeartbeat: Date | null, now: Date, timeoutMs: number) => Boolean(lastHeartbeat && now.getTime() - lastHeartbeat.getTime() <= timeoutMs);

export class StorageMetadataService {
  constructor(private readonly failureTimeoutMs: number) {}

  async recordHeartbeat(nodeId: string, name: string, alive: boolean, capacityBytes: number, usedBytes: number, at = new Date()) {
    return prisma.storageNode.upsert({
      where: { id: nodeId },
      create: { id: nodeId, name, status: alive ? StorageNodeStatus.ALIVE : StorageNodeStatus.DEAD, capacityBytes: BigInt(capacityBytes), usedBytes: BigInt(usedBytes), lastHeartbeat: alive ? at : null },
      update: { name, status: alive ? StorageNodeStatus.ALIVE : StorageNodeStatus.DEAD, capacityBytes: BigInt(capacityBytes), usedBytes: BigInt(usedBytes), ...(alive ? { lastHeartbeat: at } : {}) },
    });
  }

  async markStaleDead(now = new Date()) {
    const cutoff = new Date(now.getTime() - this.failureTimeoutMs);
    return prisma.storageNode.updateMany({ where: { status: StorageNodeStatus.ALIVE, OR: [{ lastHeartbeat: null }, { lastHeartbeat: { lt: cutoff } }] }, data: { status: StorageNodeStatus.DEAD } });
  }

  async chooseNodes(count = 2, now = new Date()) {
    await this.markStaleDead(now);
    const cutoff = new Date(now.getTime() - this.failureTimeoutMs);
    const nodes = await prisma.storageNode.findMany({
      where: { status: StorageNodeStatus.ALIVE, lastHeartbeat: { gte: cutoff } },
      include: { replicas: { where: { role: ReplicaRole.PRIMARY }, select: { id: true } } },
    });
    return chooseReplicaNodes(nodes.map(node => ({ id: node.id, usedBytes: node.usedBytes, capacityBytes: node.capacityBytes, primaryCount: node.replicas.length })), count);
  }

  async dashboard(now = new Date()) {
    await this.markStaleDead(now);
    return prisma.storageNode.findMany({ include: { _count: { select: { replicas: true } }, replicas: { select: { role: true } } }, orderBy: { name: 'asc' } });
  }

  async refreshRegistry(registry: StorageNodeRegistry) {
    await Promise.all(registry.all().map(async node => {
      const [health, capacity] = await Promise.all([node.health(), node.capacity()]);
      await this.recordHeartbeat(node.id, node.name, health.alive, capacity.capacityBytes, capacity.usedBytes, health.checkedAt);
    }));
  }

  replicaCreateData(placements: Array<{ nodeId: string; storageKey: string; role: 'PRIMARY' | 'REPLICA' }>): Prisma.FileReplicaCreateWithoutFileInput[] {
    return placements.map(item => ({ node: { connect: { id: item.nodeId } }, storageKey: item.storageKey, role: item.role === 'PRIMARY' ? ReplicaRole.PRIMARY : ReplicaRole.REPLICA }));
  }
}
