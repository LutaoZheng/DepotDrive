import { FileStatus, ReplicaRole, ReplicaStatus, StorageNodeStatus, StorageOperationStatus, StorageOperationType, type File, type FileReplica } from '@prisma/client';
import { prisma } from '../../plugins/prisma.js';
import type { StorageNodeRegistry } from '../../storage/storage-node-registry.js';
import { AppError } from '../../utils/errors.js';
import type { StorageMetadataService } from './metadata-service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { StorageOperationService } from './operation-service.js';
import type { IntegrityService } from './integrity-service.js';
import { recordStorageEvent } from './event-service.js';

export interface ReplicaPlacement { nodeId: string; storageKey: string; role: 'PRIMARY' | 'REPLICA' }
export interface PendingFileInput {
  ownerId: string;
  folderId: string | null;
  name: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  storageKey: string;
  uploadSessionId?: string;
}

type DownloadReplica = FileReplica & { node: { status: StorageNodeStatus; lastHeartbeatAt: Date | null } };

export class ReplicaService {
  constructor(
    private readonly registry: StorageNodeRegistry,
    private readonly metadata: StorageMetadataService,
    private readonly operations: StorageOperationService,
    private readonly integrity: IntegrityService,
    private readonly logger?: Pick<FastifyBaseLogger, 'error'>,
    private readonly replicaCount = 2,
  ) {}

  async prepareFile(input: PendingFileInput): Promise<File> {
    await this.metadata.refreshRegistry(this.registry);
    const selected = await this.metadata.chooseNodes(this.replicaCount);
    if (selected.length < this.replicaCount) throw new AppError(503, 'INSUFFICIENT_STORAGE_NODES', 'Not enough healthy storage nodes');
    return prisma.$transaction(async tx => {
      const file = await tx.file.create({ data: { ...input, sizeBytes: BigInt(input.sizeBytes), status: FileStatus.PENDING } });
      for (const [index, selectedNode] of selected.entries()) {
        const replica = await tx.fileReplica.create({ data: {
          fileId: file.id, nodeId: selectedNode.id, storageKey: input.storageKey,
          role: index === 0 ? ReplicaRole.PRIMARY : ReplicaRole.REPLICA,
          status: ReplicaStatus.PENDING, sizeBytes: BigInt(input.sizeBytes), sha256: input.checksum,
        } });
        await tx.storageOperation.create({ data: { type: StorageOperationType.CREATE_REPLICA, status: StorageOperationStatus.PENDING, fileId: file.id, replicaId: replica.id, storageNodeId: replica.nodeId } });
      }
      return file;
    });
  }

  async publishPrepared(fileId: string) {
    const result = await this.operations.reconcileFile(fileId);
    if (!result.available) throw new AppError(503, 'REPLICATION_INCOMPLETE', 'File is not yet available on the required number of storage nodes');
    return prisma.file.findUniqueOrThrow({ where: { id: fileId } });
  }

  async openDownload(replicas: DownloadReplica[], failureTimeoutMs: number) {
    const cutoff = Date.now() - failureTimeoutMs;
    const candidates = replicas.filter(replica => replica.status === ReplicaStatus.HEALTHY);
    const ordered = [...candidates].sort((a, b) => Number(a.role === ReplicaRole.REPLICA) - Number(b.role === ReplicaRole.REPLICA));
    let failedAttempts = 0;
    for (const replica of ordered) {
      if (replica.node.status !== StorageNodeStatus.HEALTHY || !replica.node.lastHeartbeatAt || replica.node.lastHeartbeatAt.getTime() < cutoff) { failedAttempts++; continue; }
      const verified = await this.integrity.stageVerified(replica);
      if (!verified.ok) { failedAttempts++; await this.operations.enqueueRepair(replica.id); continue; }
      const stream = this.integrity.createReadStream(verified.stagingKey);
      let cleaned = false;
      const cleanup = () => { if (cleaned) return; cleaned = true; void this.integrity.discard(verified.stagingKey); };
      stream.once('end', cleanup).once('close', cleanup).once('error', cleanup);
      if (failedAttempts > 0) await recordStorageEvent({ type: 'DOWNLOAD_FALLBACK', result: 'SUCCESS', message: `Download fell back after ${failedAttempts} failed replica attempt(s)`, fileId: replica.fileId, replicaId: replica.id, nodeId: replica.nodeId, metadata: { failedAttempts } }).catch(() => undefined);
      return { stream, nodeId: verified.nodeId };
    }
    throw new AppError(503, 'FILE_UNAVAILABLE', 'File exists but all replicas are currently unavailable');
  }

  async replicasForFile(fileId: string) {
    return prisma.fileReplica.findMany({ where: { fileId }, include: { node: { select: { status: true, lastHeartbeatAt: true } } }, orderBy: { role: 'asc' } });
  }

  async scheduleDelete(fileId: string) {
    await prisma.$transaction(async tx => {
      const file = await tx.file.update({ where: { id: fileId }, data: { status: FileStatus.DELETING } });
      const replicas = await tx.fileReplica.findMany({ where: { fileId: file.id } });
      for (const replica of replicas) {
        await tx.fileReplica.update({ where: { id: replica.id }, data: { status: ReplicaStatus.DELETE_PENDING } });
        await tx.storageOperation.upsert({
          where: { type_replicaId: { type: StorageOperationType.DELETE_REPLICA, replicaId: replica.id } },
          create: { type: StorageOperationType.DELETE_REPLICA, fileId: file.id, replicaId: replica.id, storageNodeId: replica.nodeId },
          update: { status: StorageOperationStatus.PENDING, lastError: null },
        });
      }
    });
    const result = await this.operations.reconcileFile(fileId);
    if (!result.deleted) throw new AppError(503, 'REPLICA_DELETE_PENDING', 'File deletion is pending because a storage node is unavailable');
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
}
