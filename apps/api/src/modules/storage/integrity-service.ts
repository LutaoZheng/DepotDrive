import { randomUUID } from 'node:crypto';
import { ReplicaStatus, StorageNodeStatus, type FileReplica } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../plugins/prisma.js';
import type { FileStorage } from '../../storage/file-storage.js';
import type { StorageNodeRegistry } from '../../storage/storage-node-registry.js';
import { recordStorageEvent } from './event-service.js';

type ReplicaForVerification = FileReplica & { node: { status: StorageNodeStatus } };
export type VerificationResult =
  | { ok: true; stagingKey: string; nodeId: string }
  | { ok: false; status: 'MISSING' | 'CORRUPT' | 'UNAVAILABLE'; reason: string };
type VerificationFailureStatus = 'MISSING' | 'CORRUPT' | 'UNAVAILABLE';

/** Verifies remote bytes into a private staging file before any consumer can read them. */
export class IntegrityService {
  constructor(
    private readonly registry: StorageNodeRegistry,
    private readonly staging: FileStorage,
    private readonly logger: Pick<FastifyBaseLogger, 'error' | 'info'>,
  ) {}

  private async fail(replica: FileReplica, status: VerificationFailureStatus, reason: string): Promise<VerificationResult> {
    await prisma.fileReplica.update({ where: { id: replica.id }, data: { status } }).catch(() => undefined);
    await recordStorageEvent({ type: `REPLICA_${status}`, result: 'FAILURE', message: reason, fileId: replica.fileId, replicaId: replica.id, nodeId: replica.nodeId }).catch(() => undefined);
    this.logger.error({ replicaId: replica.id, nodeId: replica.nodeId, storageKey: replica.storageKey, reason }, 'Replica integrity verification failed');
    return { ok: false, status, reason };
  }

  async stageVerified(replica: ReplicaForVerification): Promise<VerificationResult> {
    if (replica.node.status !== StorageNodeStatus.HEALTHY) return this.fail(replica, ReplicaStatus.UNAVAILABLE, 'Storage node is not healthy');
    const node = this.registry.get(replica.nodeId);
    if (!node) return this.fail(replica, ReplicaStatus.UNAVAILABLE, 'Storage node is not registered');
    let stagingKey: string | undefined;
    try {
      const metadata = await node.metadata(replica.storageKey);
      if (!metadata) return this.fail(replica, ReplicaStatus.MISSING, 'Object is missing');
      if (metadata.sizeBytes !== Number(replica.sizeBytes) || metadata.checksum !== replica.sha256) {
        return this.fail(replica, ReplicaStatus.CORRUPT, 'Persisted object metadata does not match authoritative replica metadata');
      }
      stagingKey = randomUUID();
      const stored = await this.staging.save({ storageKey: stagingKey, stream: await node.download(replica.storageKey) });
      if (stored.sizeBytes !== Number(replica.sizeBytes) || stored.checksum !== replica.sha256) {
        await this.staging.delete(stagingKey).catch(() => undefined);
        return this.fail(replica, ReplicaStatus.CORRUPT, 'Object bytes do not match authoritative replica metadata');
      }
      await prisma.fileReplica.update({ where: { id: replica.id }, data: { status: ReplicaStatus.HEALTHY, lastVerifiedAt: new Date() } });
      await recordStorageEvent({ type: 'REPLICA_VERIFIED', result: 'SUCCESS', message: 'Replica bytes matched authoritative size and SHA-256', fileId: replica.fileId, replicaId: replica.id, nodeId: replica.nodeId }).catch(() => undefined);
      return { ok: true, stagingKey, nodeId: node.id };
    } catch (error) {
      if (stagingKey) await this.staging.delete(stagingKey).catch(() => undefined);
      return this.fail(replica, ReplicaStatus.UNAVAILABLE, error instanceof Error ? error.message : 'Storage node request failed');
    }
  }

  async discard(stagingKey: string) { await this.staging.delete(stagingKey).catch(() => undefined); }
  createReadStream(stagingKey: string) { return this.staging.createReadStream(stagingKey); }
}
