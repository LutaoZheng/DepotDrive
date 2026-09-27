import { FileStatus, ReplicaRole, ReplicaStatus, StorageNodeStatus, StorageOperationStatus, StorageOperationType } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../plugins/prisma.js';
import type { FileStorage } from '../../storage/file-storage.js';
import type { StorageNodeRegistry } from '../../storage/storage-node-registry.js';
import type { IntegrityService } from './integrity-service.js';
import { recordStorageEvent } from './event-service.js';

export class StorageOperationService {
  constructor(
    private readonly registry: StorageNodeRegistry,
    private readonly staging: FileStorage,
    private readonly integrity: IntegrityService,
    private readonly logger: Pick<FastifyBaseLogger, 'error' | 'info'>,
  ) {}

  private message(error: unknown) { return error instanceof Error ? error.message.slice(0, 1000) : 'Unknown storage operation error'; }

  private async claim(operationId: string) {
    const claimed = await prisma.storageOperation.updateMany({
      where: { id: operationId, status: { in: [StorageOperationStatus.PENDING, StorageOperationStatus.FAILED] } },
      data: { status: StorageOperationStatus.RUNNING, attempts: { increment: 1 }, lastError: null },
    });
    return claimed.count === 1;
  }

  private async runCreate(operationId: string) {
    const operation = await prisma.storageOperation.findUniqueOrThrow({ where: { id: operationId }, include: { file: true, replica: true } });
    const node = this.registry.require(operation.storageNodeId);
    try {
      if (!await this.staging.exists(operation.file.storageKey)) throw new Error('Staging object is missing');
      const stored = await node.upload({
        storageKey: operation.replica.storageKey,
        stream: this.staging.createReadStream(operation.file.storageKey),
        expectedSizeBytes: Number(operation.replica.sizeBytes),
        expectedChecksum: operation.replica.sha256,
      });
      if (stored.sizeBytes !== Number(operation.replica.sizeBytes) || stored.checksum !== operation.replica.sha256) throw new Error('Storage node returned mismatched object metadata');
      await prisma.$transaction([
        prisma.fileReplica.update({ where: { id: operation.replicaId }, data: { status: ReplicaStatus.HEALTHY, lastVerifiedAt: new Date() } }),
        prisma.storageOperation.update({ where: { id: operation.id }, data: { status: StorageOperationStatus.DONE, lastError: null } }),
      ]);
    } catch (error) {
      await prisma.$transaction([
        prisma.fileReplica.update({ where: { id: operation.replicaId }, data: { status: ReplicaStatus.UNAVAILABLE } }),
        prisma.storageOperation.update({ where: { id: operation.id }, data: { status: StorageOperationStatus.FAILED, lastError: this.message(error) } }),
      ]);
      this.logger.error({ error, operationId, fileId: operation.fileId, nodeId: operation.storageNodeId }, 'Create replica operation failed');
    }
  }

  private async runDelete(operationId: string) {
    const operation = await prisma.storageOperation.findUniqueOrThrow({ where: { id: operationId }, include: { replica: true } });
    const node = this.registry.require(operation.storageNodeId);
    try {
      await node.delete(operation.replica.storageKey);
      await prisma.storageOperation.update({ where: { id: operation.id }, data: { status: StorageOperationStatus.DONE, lastError: null } });
    } catch (error) {
      await prisma.storageOperation.update({ where: { id: operation.id }, data: { status: StorageOperationStatus.FAILED, lastError: this.message(error) } });
      this.logger.error({ error, operationId, fileId: operation.fileId, nodeId: operation.storageNodeId }, 'Delete replica operation failed');
    }
  }

  private async runRepair(operationId: string) {
    const operation = await prisma.storageOperation.findUniqueOrThrow({ where: { id: operationId }, include: { file: true, replica: { include: { node: true } } } });
    let stagingKey: string | undefined;
    try {
      await recordStorageEvent({ type: 'REPAIR_STARTED', result: 'INFO', message: 'Replica repair operation started', fileId: operation.fileId, replicaId: operation.replicaId, nodeId: operation.storageNodeId, metadata: { operationId } }).catch(() => undefined);
      if (operation.file.status !== FileStatus.AVAILABLE) throw new Error('Only available files are repairable');
      if (operation.replica.node.status !== StorageNodeStatus.HEALTHY) throw new Error('Repair target node is unavailable');
      const source = await prisma.fileReplica.findFirst({
        where: { fileId: operation.fileId, id: { not: operation.replicaId }, status: ReplicaStatus.HEALTHY, node: { status: StorageNodeStatus.HEALTHY } },
        include: { node: { select: { status: true } } },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      });
      if (!source) throw new Error('No healthy source replica is available');
      const verified = await this.integrity.stageVerified(source);
      if (!verified.ok) throw new Error(`Source replica verification failed: ${verified.reason}`);
      stagingKey = verified.stagingKey;
      const target = this.registry.require(operation.storageNodeId);
      const stored = await target.upload({
        storageKey: operation.replica.storageKey,
        stream: this.staging.createReadStream(stagingKey),
        expectedSizeBytes: Number(operation.replica.sizeBytes),
        expectedChecksum: operation.replica.sha256,
        allowReplace: true,
      });
      if (stored.sizeBytes !== Number(operation.replica.sizeBytes) || stored.checksum !== operation.replica.sha256) throw new Error('Repair target returned mismatched object metadata');
      const targetMetadata = await target.metadata(operation.replica.storageKey);
      if (!targetMetadata || targetMetadata.sizeBytes !== Number(operation.replica.sizeBytes) || targetMetadata.checksum !== operation.replica.sha256) throw new Error('Repair target verification failed');
      await prisma.$transaction([
        prisma.fileReplica.update({ where: { id: operation.replicaId }, data: { status: ReplicaStatus.HEALTHY, lastVerifiedAt: new Date() } }),
        prisma.storageOperation.update({ where: { id: operation.id }, data: { status: StorageOperationStatus.DONE, lastError: null } }),
      ]);
      await recordStorageEvent({ type: 'REPLICA_RESTORED', result: 'SUCCESS', message: 'Replica repaired and replication restored', fileId: operation.fileId, replicaId: operation.replicaId, nodeId: operation.storageNodeId, metadata: { operationId } }).catch(() => undefined);
    } catch (error) {
      await prisma.storageOperation.update({ where: { id: operation.id }, data: { status: StorageOperationStatus.FAILED, lastError: this.message(error) } });
      this.logger.error({ error, operationId, fileId: operation.fileId, nodeId: operation.storageNodeId }, 'Repair replica operation failed');
      await recordStorageEvent({ type: 'REPAIR_FAILED', result: 'FAILURE', message: this.message(error), fileId: operation.fileId, replicaId: operation.replicaId, nodeId: operation.storageNodeId, metadata: { operationId } }).catch(() => undefined);
    } finally {
      if (stagingKey) await this.integrity.discard(stagingKey);
    }
  }

  async run(operationId: string) {
    if (!await this.claim(operationId)) return;
    const operation = await prisma.storageOperation.findUniqueOrThrow({ where: { id: operationId } });
    if (operation.type === StorageOperationType.CREATE_REPLICA) await this.runCreate(operation.id);
    else if (operation.type === StorageOperationType.DELETE_REPLICA) await this.runDelete(operation.id);
    else await this.runRepair(operation.id);
  }

  async enqueueRepair(replicaId: string) {
    const replica = await prisma.fileReplica.findUnique({ where: { id: replicaId }, include: { file: { select: { status: true } } } });
    if (!replica || replica.file.status !== FileStatus.AVAILABLE || replica.status === ReplicaStatus.HEALTHY || replica.status === ReplicaStatus.DELETE_PENDING) return false;
    await prisma.storageOperation.upsert({
      where: { type_replicaId: { type: StorageOperationType.REPAIR_REPLICA, replicaId } },
      create: { type: StorageOperationType.REPAIR_REPLICA, fileId: replica.fileId, replicaId, storageNodeId: replica.nodeId },
      update: { status: StorageOperationStatus.PENDING, lastError: null, storageNodeId: replica.nodeId },
    });
    return true;
  }

  private async createReplacement(fileId: string) {
    const file = await prisma.file.findUnique({ where: { id: fileId }, include: { replicas: true } });
    if (!file || file.status !== FileStatus.AVAILABLE) return false;
    const existingNodeIds = new Set(file.replicas.map(replica => replica.nodeId));
    const target = await prisma.storageNode.findFirst({ where: { status: StorageNodeStatus.HEALTHY, id: { notIn: [...existingNodeIds] } }, orderBy: { id: 'asc' } });
    if (!target) return false;
    try {
      await prisma.$transaction(async tx => {
        const replica = await tx.fileReplica.create({ data: {
          fileId, nodeId: target.id, storageKey: file.storageKey, role: ReplicaRole.REPLICA,
          status: ReplicaStatus.PENDING, sizeBytes: file.sizeBytes, sha256: file.checksum,
        } });
        await tx.storageOperation.create({ data: { type: StorageOperationType.REPAIR_REPLICA, fileId, replicaId: replica.id, storageNodeId: target.id } });
      });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return false;
      throw error;
    }
  }

  async reconcileRepairs(unavailableGraceMs: number, batchSize: number) {
    const files = await prisma.file.findMany({
      where: { status: FileStatus.AVAILABLE, OR: [
        { replicas: { some: { status: { not: ReplicaStatus.HEALTHY } } } },
        { replicas: { some: { node: { status: StorageNodeStatus.UNAVAILABLE } } } },
      ] },
      include: { replicas: { include: { node: { select: { status: true, lastHeartbeatAt: true } } } } },
    });
    const unavailableCutoff = Date.now() - unavailableGraceMs;
    for (const file of files) {
      for (const replica of file.replicas) {
        if (replica.status === ReplicaStatus.HEALTHY && replica.node.status === StorageNodeStatus.UNAVAILABLE && (!replica.node.lastHeartbeatAt || replica.node.lastHeartbeatAt.getTime() <= unavailableCutoff)) {
          await prisma.fileReplica.update({ where: { id: replica.id }, data: { status: ReplicaStatus.UNAVAILABLE } });
          replica.status = ReplicaStatus.UNAVAILABLE;
        }
      }
      if (file.replicas.filter(replica => replica.status === ReplicaStatus.HEALTHY && replica.node.status === StorageNodeStatus.HEALTHY).length >= 2) continue;
      let scheduled = false;
      for (const replica of file.replicas) {
        const immediate = replica.status === ReplicaStatus.MISSING || replica.status === ReplicaStatus.CORRUPT || replica.status === ReplicaStatus.PENDING;
        const unavailableReady = replica.status === ReplicaStatus.UNAVAILABLE && replica.updatedAt.getTime() <= unavailableCutoff;
        if ((immediate || unavailableReady) && replica.node.status === StorageNodeStatus.HEALTHY) scheduled = await this.enqueueRepair(replica.id) || scheduled;
      }
      if (!scheduled) await this.createReplacement(file.id);
    }
    const operations = await prisma.storageOperation.findMany({ where: { type: StorageOperationType.REPAIR_REPLICA, status: StorageOperationStatus.PENDING }, orderBy: { updatedAt: 'asc' }, take: batchSize });
    for (const operation of operations) await this.run(operation.id);
    return operations.length;
  }

  async reconcileFile(fileId: string) {
    const operations = await prisma.storageOperation.findMany({ where: { fileId, status: { not: StorageOperationStatus.DONE } }, orderBy: { createdAt: 'asc' } });
    for (const operation of operations) await this.run(operation.id);
    const file = await prisma.file.findUnique({ where: { id: fileId }, include: { replicas: true, operations: true } });
    if (!file) return { available: false, deleted: true };
    if (file.status === FileStatus.DELETING) {
      const deleteOperations = file.operations.filter(operation => operation.type === StorageOperationType.DELETE_REPLICA);
      if (deleteOperations.length === file.replicas.length && deleteOperations.every(operation => operation.status === StorageOperationStatus.DONE)) {
        await prisma.file.delete({ where: { id: file.id } });
        return { available: false, deleted: true };
      }
      return { available: false, deleted: false };
    }
    const healthy = file.replicas.filter(replica => replica.status === ReplicaStatus.HEALTHY).length;
    if (healthy >= 2) {
      await prisma.file.update({ where: { id: file.id }, data: { status: FileStatus.AVAILABLE } });
      if (file.uploadSessionId) await prisma.uploadSession.delete({ where: { id: file.uploadSessionId } }).catch(() => undefined);
      await this.staging.delete(file.storageKey).catch(error => this.logger.error({ error, fileId }, 'Failed to clean staging object'));
      if (file.uploadSessionId) await this.staging.deleteUploadSession(file.uploadSessionId).catch(error => this.logger.error({ error, fileId }, 'Failed to clean upload chunks'));
      return { available: true, deleted: false };
    }
    return { available: false, deleted: false };
  }

  async reconcileIncomplete() {
    await prisma.storageOperation.updateMany({ where: { status: StorageOperationStatus.RUNNING }, data: { status: StorageOperationStatus.PENDING, lastError: 'Recovered after coordinator restart' } });
    const repairs = await prisma.storageOperation.findMany({ where: { type: StorageOperationType.REPAIR_REPLICA, status: StorageOperationStatus.PENDING }, select: { id: true } });
    for (const repair of repairs) await this.run(repair.id);
    const files = await prisma.file.findMany({ where: { status: { in: [FileStatus.PENDING, FileStatus.DELETING] } }, select: { id: true } });
    for (const file of files) await this.reconcileFile(file.id);
    this.logger.info({ fileCount: files.length, repairCount: repairs.length }, 'Reconciled incomplete storage operations');
    return files.length + repairs.length;
  }
}
