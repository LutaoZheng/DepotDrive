import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ReplicaRole, ReplicaStatus, StorageNodeStatus } from '@prisma/client';
import type { StorageNode } from '../src/storage/storage-node.js';
import { StorageNodeRegistry } from '../src/storage/storage-node-registry.js';
import { chooseReplicaNodes } from '../src/modules/storage/placement.js';
import { ReplicaService } from '../src/modules/storage/replica-service.js';
import { HeartbeatService } from '../src/modules/storage/heartbeat-service.js';
import { isHeartbeatFresh } from '../src/modules/storage/metadata-service.js';

function node(id: string, options: { alive?: boolean; metadata?: boolean } = {}): StorageNode {
  return {
    id, name: `Storage ${id}`, endpoint: `http://${id}`,
    upload: vi.fn(async input => ({ storageKey: input.storageKey, sizeBytes: input.expectedSizeBytes ?? 1, checksum: input.expectedChecksum ?? 'x' })),
    download: vi.fn(async () => Readable.from('data')),
    delete: vi.fn(async () => undefined),
    exists: vi.fn(async () => options.metadata ?? true),
    metadata: vi.fn(async () => options.metadata === false ? null : ({ sizeBytes: 4, checksum: 'x' })),
    health: vi.fn(async () => ({ alive: options.alive ?? true, checkedAt: new Date() })),
    capacity: vi.fn(async () => ({ capacityBytes: 1000, usedBytes: 10 })),
  };
}

function replica(nodeId: string, role: ReplicaRole, status = ReplicaStatus.HEALTHY) {
  const now = new Date();
  return { id: `${nodeId}-replica`, fileId: 'f', nodeId, storageKey: 'k', role, status, sizeBytes: 4n, sha256: 'x', lastVerifiedAt: null, createdAt: now, updatedAt: now, node: { status: StorageNodeStatus.HEALTHY, lastHeartbeatAt: now } };
}

function services(registry: StorageNodeRegistry) {
  return {
    operations: { enqueueRepair: vi.fn(async () => true) },
    integrity: {
      stageVerified: vi.fn(async (value: ReturnType<typeof replica>) => {
        const target = registry.require(value.nodeId);
        const metadata = await target.metadata(value.storageKey);
        if (!metadata) return { ok: false, status: ReplicaStatus.MISSING, reason: 'missing' } as const;
        try { await target.download(value.storageKey); return { ok: true, stagingKey: value.id, nodeId: value.nodeId } as const; }
        catch { return { ok: false, status: ReplicaStatus.UNAVAILABLE, reason: 'failed' } as const; }
      }),
      createReadStream: vi.fn(() => Readable.from('data')),
      discard: vi.fn(async () => undefined),
    },
  };
}

describe('distributed storage system', () => {
  it('places primary and replica on two distinct least-utilized nodes', () => {
    expect(chooseReplicaNodes([{ id: 'A', usedBytes: 50n, capacityBytes: 100n, primaryCount: 0 }, { id: 'B', usedBytes: 10n, capacityBytes: 100n, primaryCount: 2 }, { id: 'C', usedBytes: 20n, capacityBytes: 100n, primaryCount: 0 }], 2).map(item => item.id)).toEqual(['B', 'C']);
  });

  it('opens the primary first when both replicas are healthy', async () => {
    const a = node('A'), b = node('B');
    const registry = new StorageNodeRegistry([a, b]), dependencies = services(registry);
    const service = new ReplicaService(registry, {} as never, dependencies.operations as never, dependencies.integrity as never);
    expect((await service.openDownload([replica('A', ReplicaRole.PRIMARY), replica('B', ReplicaRole.REPLICA)] as never, 30_000)).nodeId).toBe('A');
    expect(b.download).not.toHaveBeenCalled();
  });

  it('falls back when the primary object is missing', async () => {
    const a = node('A', { metadata: false }), b = node('B');
    const registry = new StorageNodeRegistry([a, b]), dependencies = services(registry);
    const service = new ReplicaService(registry, {} as never, dependencies.operations as never, dependencies.integrity as never, { error: vi.fn() } as never);
    expect((await service.openDownload([replica('A', ReplicaRole.PRIMARY), replica('B', ReplicaRole.REPLICA)] as never, 30_000)).nodeId).toBe('B');
    expect(a.download).not.toHaveBeenCalled();
  });

  it('falls back when opening the primary download stream fails', async () => {
    const a = node('A'), b = node('B');
    vi.mocked(a.download).mockRejectedValueOnce(new Error('open failed'));
    const registry = new StorageNodeRegistry([a, b]), dependencies = services(registry);
    const service = new ReplicaService(registry, {} as never, dependencies.operations as never, dependencies.integrity as never, { error: vi.fn() } as never);
    expect((await service.openDownload([replica('A', ReplicaRole.PRIMARY), replica('B', ReplicaRole.REPLICA)] as never, 30_000)).nodeId).toBe('B');
  });

  it('returns 503 when every replica is unavailable', async () => {
    const a = node('A'), b = node('B');
    const replicas = [replica('A', ReplicaRole.PRIMARY), replica('B', ReplicaRole.REPLICA)];
    replicas[0]!.node.status = StorageNodeStatus.UNAVAILABLE;
    replicas[1]!.node.status = StorageNodeStatus.UNAVAILABLE;
    const registry = new StorageNodeRegistry([a, b]), dependencies = services(registry);
    const service = new ReplicaService(registry, {} as never, dependencies.operations as never, dependencies.integrity as never);
    await expect(service.openDownload(replicas as never, 30_000)).rejects.toMatchObject({ status: 503, code: 'FILE_UNAVAILABLE' });
    expect(a.download).not.toHaveBeenCalled();
    expect(b.download).not.toHaveBeenCalled();
  });

  it('detects a node as failed after the 30-second heartbeat deadline', () => {
    const now = new Date('2026-08-03T00:00:31.000Z');
    expect(isHeartbeatFresh(new Date('2026-08-03T00:00:01.000Z'), now, 30_000)).toBe(true);
    expect(isHeartbeatFresh(new Date('2026-08-03T00:00:00.999Z'), now, 30_000)).toBe(false);
    expect(isHeartbeatFresh(null, now, 30_000)).toBe(false);
  });

  it('heartbeats every registered node and runs failure detection', async () => {
    const metadata = { recordHeartbeat: vi.fn(), markStaleDead: vi.fn() };
    const service = new HeartbeatService(new StorageNodeRegistry([node('A'), node('B')]), metadata as never, 10_000, { error: vi.fn() } as never);
    await service.tick();
    expect(metadata.recordHeartbeat).toHaveBeenCalledTimes(2);
    expect(metadata.markStaleDead).toHaveBeenCalledOnce();
  });
});
