import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ReplicaRole, StorageNodeStatus } from '@prisma/client';
import type { StorageNode } from '../src/storage/storage-node.js';
import { StorageNodeRegistry } from '../src/storage/storage-node-registry.js';
import { chooseReplicaNodes } from '../src/modules/storage/placement.js';
import { ReplicaService } from '../src/modules/storage/replica-service.js';
import { HeartbeatService } from '../src/modules/storage/heartbeat-service.js';
import { isHeartbeatFresh } from '../src/modules/storage/metadata-service.js';

function node(id: string, options: { alive?: boolean; exists?: boolean } = {}): StorageNode {
  return { id, name: `Storage ${id}`, upload: vi.fn(async input => ({ storageKey: input.storageKey, sizeBytes: 1, checksum: 'x' })), download: vi.fn(async () => Readable.from('data')), delete: vi.fn(async () => undefined), exists: vi.fn(async () => options.exists ?? true), health: vi.fn(async () => ({ alive: options.alive ?? true, checkedAt: new Date() })), capacity: vi.fn(async () => ({ capacityBytes: 1000, usedBytes: 10 })) };
}

describe('distributed storage system', () => {
  it('places primary and replica on two distinct least-utilized nodes', () => {
    expect(chooseReplicaNodes([{ id: 'A', usedBytes: 50n, capacityBytes: 100n, primaryCount: 0 }, { id: 'B', usedBytes: 10n, capacityBytes: 100n, primaryCount: 2 }, { id: 'C', usedBytes: 20n, capacityBytes: 100n, primaryCount: 0 }], 2).map(item => item.id)).toEqual(['B', 'C']);
  });

  it('writes two replicas and compensates already-written replicas on failure', async () => {
    const a = node('A'), b = node('B');
    const registry = new StorageNodeRegistry([a, b]);
    const metadata = { refreshRegistry: vi.fn(), chooseNodes: vi.fn().mockResolvedValue([{ id: 'A' }, { id: 'B' }]) };
    const service = new ReplicaService(registry, metadata as never);
    const source = { createReadStream: vi.fn(() => Readable.from('x')) };
    const placements = await service.replicateFrom(source as never, '00000000-0000-4000-8000-000000000001');
    expect(placements).toEqual([{ nodeId: 'A', storageKey: expect.any(String), role: 'PRIMARY' }, { nodeId: 'B', storageKey: expect.any(String), role: 'REPLICA' }]);
    vi.mocked(b.upload).mockRejectedValueOnce(new Error('disk failed'));
    await expect(service.replicateFrom(source as never, '00000000-0000-4000-8000-000000000002')).rejects.toThrow('disk failed');
    expect(a.delete).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002');
  });

  it('logs replica compensation failures with traceable node information', async () => {
    const a = node('A'), b = node('B');
    vi.mocked(b.upload).mockRejectedValueOnce(new Error('second write failed'));
    vi.mocked(a.delete).mockRejectedValueOnce(new Error('compensation delete failed'));
    const logger = { error: vi.fn() };
    const metadata = { refreshRegistry: vi.fn(), chooseNodes: vi.fn().mockResolvedValue([{ id: 'A' }, { id: 'B' }]) };
    const service = new ReplicaService(new StorageNodeRegistry([a, b]), metadata as never, logger as never);
    await expect(service.replicateFrom({ createReadStream: () => Readable.from('x') } as never, '00000000-0000-4000-8000-000000000003')).rejects.toThrow('second write failed');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'A', storageKey: '00000000-0000-4000-8000-000000000003' }), 'Failed to delete storage replica');
  });

  it('falls back from an unhealthy primary to a healthy replica', async () => {
    const a = node('A', { alive: false }), b = node('B');
    const service = new ReplicaService(new StorageNodeRegistry([a, b]), {} as never);
    const now = new Date();
    const replicas = [{ id: '1', fileId: 'f', nodeId: 'A', storageKey: 'k', role: ReplicaRole.PRIMARY, createdAt: now, node: { status: StorageNodeStatus.ALIVE, lastHeartbeat: now } }, { id: '2', fileId: 'f', nodeId: 'B', storageKey: 'k', role: ReplicaRole.REPLICA, createdAt: now, node: { status: StorageNodeStatus.ALIVE, lastHeartbeat: now } }];
    expect((await service.openDownload(replicas as never, 30_000)).nodeId).toBe('B');
    expect(a.download).not.toHaveBeenCalled();
    expect(b.download).toHaveBeenCalled();
  });

  it('opens the primary first when both replicas are healthy', async () => {
    const a = node('A'), b = node('B');
    const service = new ReplicaService(new StorageNodeRegistry([a, b]), {} as never);
    const now = new Date();
    const replicas = [{ id: '1', fileId: 'f', nodeId: 'A', storageKey: 'k', role: ReplicaRole.PRIMARY, createdAt: now, node: { status: StorageNodeStatus.ALIVE, lastHeartbeat: now } }, { id: '2', fileId: 'f', nodeId: 'B', storageKey: 'k', role: ReplicaRole.REPLICA, createdAt: now, node: { status: StorageNodeStatus.ALIVE, lastHeartbeat: now } }];
    expect((await service.openDownload(replicas as never, 30_000)).nodeId).toBe('A');
    expect(b.download).not.toHaveBeenCalled();
  });

  it('falls back when opening the primary download stream fails', async () => {
    const a = node('A'), b = node('B');
    vi.mocked(a.download).mockRejectedValueOnce(new Error('open failed'));
    const service = new ReplicaService(new StorageNodeRegistry([a, b]), {} as never, { error: vi.fn() } as never);
    const now = new Date();
    const replicas = [{ id: '1', fileId: 'f', nodeId: 'A', storageKey: 'k', role: ReplicaRole.PRIMARY, createdAt: now, node: { status: StorageNodeStatus.ALIVE, lastHeartbeat: now } }, { id: '2', fileId: 'f', nodeId: 'B', storageKey: 'k', role: ReplicaRole.REPLICA, createdAt: now, node: { status: StorageNodeStatus.ALIVE, lastHeartbeat: now } }];
    expect((await service.openDownload(replicas as never, 30_000)).nodeId).toBe('B');
  });

  it('reports replica deletion failures instead of losing metadata tracking silently', async () => {
    const a = node('A'), b = node('B');
    vi.mocked(a.delete).mockRejectedValueOnce(new Error('node offline'));
    const logger = { error: vi.fn() };
    const service = new ReplicaService(new StorageNodeRegistry([a, b]), {} as never, logger as never);
    await expect(service.deleteFileReplicas([{ nodeId: 'A', storageKey: 'k' }, { nodeId: 'B', storageKey: 'k' }])).rejects.toMatchObject({ code: 'REPLICA_DELETE_FAILED' });
    expect(logger.error).toHaveBeenCalled();
    expect(b.delete).toHaveBeenCalledWith('k');
  });

  it('skips metadata-marked dead nodes without probing them', async () => {
    const a = node('A');
    const service = new ReplicaService(new StorageNodeRegistry([a]), {} as never);
    const replica = [{ id: '1', fileId: 'f', nodeId: 'A', storageKey: 'k', role: ReplicaRole.PRIMARY, createdAt: new Date(), node: { status: StorageNodeStatus.DEAD, lastHeartbeat: new Date() } }];
    await expect(service.openDownload(replica as never, 30_000)).rejects.toMatchObject({ code: 'FILE_CONTENT_MISSING' });
    expect(a.health).not.toHaveBeenCalled();
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
