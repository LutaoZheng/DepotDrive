import type { FastifyBaseLogger } from 'fastify';
import type { StorageNodeRegistry } from '../../storage/storage-node-registry.js';
import type { StorageMetadataService } from './metadata-service.js';

export class HeartbeatService {
  private timer?: NodeJS.Timeout;
  constructor(private readonly registry: StorageNodeRegistry, private readonly metadata: StorageMetadataService, private readonly intervalMs: number, private readonly logger: FastifyBaseLogger) {}
  async tick() {
    await Promise.all(this.registry.all().map(async node => {
      try {
        const [health, capacity] = await Promise.all([node.health(), node.capacity()]);
        await this.metadata.recordHeartbeat(node.id, node.name, health.alive, capacity.capacityBytes, capacity.usedBytes, health.checkedAt);
      } catch (error) {
        this.logger.error({ error, storageNodeId: node.id }, 'Storage node heartbeat failed');
        const capacity = await node.capacity().catch(() => ({ capacityBytes: 0, usedBytes: 0 }));
        await this.metadata.recordHeartbeat(node.id, node.name, false, capacity.capacityBytes || 1, capacity.usedBytes).catch(() => undefined);
      }
    }));
    await this.metadata.markStaleDead();
  }
  start() { if (this.timer) return; this.timer = setInterval(() => void this.tick(), this.intervalMs); this.timer.unref(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
