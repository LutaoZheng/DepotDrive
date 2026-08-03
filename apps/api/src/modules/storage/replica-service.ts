import { ReplicaRole, StorageNodeStatus, type FileReplica } from '@prisma/client';
import { prisma } from '../../plugins/prisma.js';
import type { FileStorage } from '../../storage/file-storage.js';
import type { StorageNodeRegistry } from '../../storage/storage-node-registry.js';
import { AppError } from '../../utils/errors.js';
import type { StorageMetadataService } from './metadata-service.js';
import type { FastifyBaseLogger } from 'fastify';

export interface ReplicaPlacement { nodeId: string; storageKey: string; role: 'PRIMARY' | 'REPLICA' }

export class ReplicaService {
  constructor(private readonly registry: StorageNodeRegistry, private readonly metadata: StorageMetadataService, private readonly logger?: Pick<FastifyBaseLogger, 'error'>, private readonly replicaCount = 2) {}

  async replicateFrom(source: FileStorage, storageKey: string): Promise<ReplicaPlacement[]> {
    await this.metadata.refreshRegistry(this.registry);
    const selected = await this.metadata.chooseNodes(this.replicaCount);
    if (selected.length < this.replicaCount) throw new AppError(503, 'INSUFFICIENT_STORAGE_NODES', 'Not enough healthy storage nodes');
    const written: ReplicaPlacement[] = [];
    try {
      for (const [index, selectedNode] of selected.entries()) {
        const node = this.registry.require(selectedNode.id);
        await node.upload({ storageKey, stream: source.createReadStream(storageKey) });
        written.push({ nodeId: node.id, storageKey, role: index === 0 ? 'PRIMARY' : 'REPLICA' });
      }
      return written;
    } catch (error) {
      await this.deletePlacements(written, 'replication compensation');
      throw error;
    }
  }

  async deletePlacements(placements: Array<Pick<ReplicaPlacement, 'nodeId' | 'storageKey'>>, reason = 'replica cleanup') {
    const failures: Array<{ nodeId: string; storageKey: string; error: unknown }> = [];
    await Promise.all(placements.map(async placement => {
      const node = this.registry.get(placement.nodeId);
      if (!node) { failures.push({ ...placement, error: new Error('Storage node is not registered') }); return; }
      try { await node.delete(placement.storageKey); }
      catch (error) { failures.push({ ...placement, error }); this.logger?.error({ error, nodeId: placement.nodeId, storageKey: placement.storageKey, reason }, 'Failed to delete storage replica'); }
    }));
    return failures;
  }

  async deleteFileReplicas(placements: Array<Pick<ReplicaPlacement, 'nodeId' | 'storageKey'>>) {
    const failures = await this.deletePlacements(placements, 'user file deletion');
    if (failures.length) throw new AppError(503, 'REPLICA_DELETE_FAILED', 'One or more file replicas could not be deleted');
  }

  async openDownload(replicas: Array<FileReplica & { node: { status: StorageNodeStatus; lastHeartbeat: Date | null } }>, failureTimeoutMs: number) {
    const cutoff = Date.now() - failureTimeoutMs;
    const ordered = [...replicas].sort((a, b) => Number(a.role === ReplicaRole.REPLICA) - Number(b.role === ReplicaRole.REPLICA));
    for (const replica of ordered) {
      if (replica.node.status !== StorageNodeStatus.ALIVE || !replica.node.lastHeartbeat || replica.node.lastHeartbeat.getTime() < cutoff) continue;
      const node = this.registry.get(replica.nodeId);
      if (!node) continue;
      const health = await node.health();
      if (!health.alive || !await node.exists(replica.storageKey)) continue;
      try { return { stream: await node.download(replica.storageKey), nodeId: node.id }; }
      catch (error) { this.logger?.error({ error, nodeId: node.id, storageKey: replica.storageKey }, 'Failed to open replica for download'); }
    }
    throw new AppError(404, 'FILE_CONTENT_MISSING', 'File content is missing');
  }

  async replicasForFile(fileId: string) {
    return prisma.fileReplica.findMany({ where: { fileId }, include: { node: { select: { status: true, lastHeartbeat: true } } }, orderBy: { role: 'asc' } });
  }
}
