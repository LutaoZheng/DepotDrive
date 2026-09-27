import { ReplicaStatus } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../plugins/prisma.js';
import type { IntegrityService } from './integrity-service.js';
import type { StorageOperationService } from './operation-service.js';
import { recordStorageEvent } from './event-service.js';

export class ScrubService {
  constructor(
    private readonly integrity: IntegrityService,
    private readonly operations: StorageOperationService,
    private readonly logger: Pick<FastifyBaseLogger, 'error' | 'info'>,
  ) {}

  async tick(batchSize: number) {
    const replicas = await prisma.fileReplica.findMany({
      where: { status: ReplicaStatus.HEALTHY, file: { status: 'AVAILABLE' } },
      include: { node: { select: { status: true } } },
      orderBy: [{ lastVerifiedAt: { sort: 'asc', nulls: 'first' } }, { updatedAt: 'asc' }],
      take: batchSize,
    });
    let failed = 0;
    for (const replica of replicas) {
      const result = await this.integrity.stageVerified(replica);
      if (result.ok) await this.integrity.discard(result.stagingKey);
      else { failed++; await this.operations.enqueueRepair(replica.id); }
    }
    this.logger.info({ checked: replicas.length, failed }, 'Replica scrub batch completed');
    await recordStorageEvent({ type: 'SCRUB_COMPLETED', result: failed ? 'FAILURE' : 'SUCCESS', message: `Integrity scrub checked ${replicas.length} replica(s); ${failed} failed`, metadata: { checked: replicas.length, failed } }).catch(() => undefined);
    return { checked: replicas.length, failed };
  }
}
