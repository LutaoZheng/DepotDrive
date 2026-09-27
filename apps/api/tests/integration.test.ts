import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import FormData from 'form-data';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStatus, ReplicaStatus, StorageNodeStatus, StorageOperationStatus } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/plugins/prisma.js';
import { MAX_UPLOAD_FILE_SIZE } from '@depot-drive/shared';
import { cleanupExpiredUploads } from '../src/modules/uploads/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required; run `npm test` to start the isolated PostgreSQL test environment');
const endpoints = process.env.STORAGE_NODE_ENDPOINTS ?? '';
if (!endpoints) throw new Error('STORAGE_NODE_ENDPOINTS is required for integration tests');
const token = process.env.STORAGE_INTERNAL_TOKEN ?? '';
const runDockerFaults = process.env.RUN_DOCKER_FAULT_TESTS === 'true';
const nodeUrls = new Map(endpoints.split(',').map(value => { const [id, , endpoint] = value.split('|'); return [id!, endpoint!]; }));
let app: FastifyInstance;
let tempRoot: string;

function testEnv() {
  return {
    NODE_ENV: 'test' as const, DATABASE_URL: databaseUrl!, JWT_SECRET: 'test-secret', API_PORT: 3000,
    WEB_ORIGIN: 'http://localhost:5173', COOKIE_SECURE: false, JWT_SESSION_SECONDS: 604800,
    CHUNK_SIZE_BYTES: 8 * 1024 * 1024, UPLOAD_SESSION_TTL_SECONDS: 86400, MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER: 20, MAX_FILE_SIZE_BYTES: MAX_UPLOAD_FILE_SIZE,
    UPLOAD_ROOT: tempRoot, STORAGE_NODE_CAPACITY_BYTES: 1024 * 1024 * 1024,
    STORAGE_NODE_ENDPOINTS: endpoints, STORAGE_INTERNAL_TOKEN: token, STORAGE_REQUEST_TIMEOUT_MS: 1000,
    HEARTBEAT_INTERVAL_MS: 1000, STORAGE_FAILURE_TIMEOUT_MS: 5000,
    REPAIR_INTERVAL_MS: 1000, REPAIR_UNAVAILABLE_GRACE_MS: 1000, REPAIR_BATCH_SIZE: 10,
    SCRUB_INTERVAL_MS: 60_000, SCRUB_BATCH_SIZE: 10,
    DEMO_MODE: false, DEMO_ADMIN_EMAIL: '', DEMO_ADMIN_PASSWORD: '',
  };
}
const buildTestApp = () => buildApp({ logger: false, env: testEnv() });

function cookie(response: { headers: Record<string, unknown> }) { return String(response.headers['set-cookie']).split(';')[0]; }
async function register(email: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password123' } });
  return { response, cookie: cookie(response) };
}
async function upload(cookieValue: string, content = Buffer.from('replicated content'), filename = 'replicated.txt') {
  const form = new FormData();
  form.append('folderId', '');
  form.append('file', content, { filename, contentType: 'application/octet-stream' });
  return app.inject({ method: 'POST', url: '/api/files/upload', headers: { cookie: cookieValue, ...form.getHeaders() }, payload: form.getBuffer() });
}
async function nodeRequest(nodeId: string, route: string, init: RequestInit = {}) {
  return fetch(`${nodeUrls.get(nodeId)}${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
}
async function injectWriteFailure(nodeId: string, count = 1) {
  const response = await nodeRequest(nodeId, '/internal/faults', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ failNextPuts: count }) });
  expect(response.status).toBe(200);
}
async function corruptObject(nodeId: string, storageKey: string) {
  const response = await nodeRequest(nodeId, `/internal/objects/${storageKey}/corrupt`, { method: 'POST' });
  expect(response.status).toBe(200);
}
async function objectChecksum(nodeId: string, storageKey: string) {
  const response = await nodeRequest(nodeId, `/objects/${storageKey}`);
  expect(response.status).toBe(200);
  return createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
}
function compose(action: 'start' | 'stop', service: 'storage-test-a' | 'storage-test-b') {
  execFileSync('docker', ['compose', '-p', 'depot-drive-test', '-f', 'docker-compose.test.yml', action, service], { cwd: path.resolve(process.cwd(), '../..'), stdio: 'pipe' });
}
const serviceFor = (nodeId: string) => nodeId === 'node-a' ? 'storage-test-a' as const : 'storage-test-b' as const;
async function waitHealthy(nodeId: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if ((await nodeRequest(nodeId, '/health')).ok) return; } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${nodeId} did not become healthy`);
}

describe('DepotDrive PostgreSQL and storage-node integration', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'depot-integration-'));
    app = await buildTestApp();
    await prisma.$connect();
  });

  beforeEach(async () => {
    if (runDockerFaults) {
      compose('start', 'storage-test-a'); compose('start', 'storage-test-b');
      await Promise.all([waitHealthy('node-a'), waitHealthy('node-b')]);
      await Promise.all([injectWriteFailure('node-a', 0), injectWriteFailure('node-b', 0)]);
    }
    await prisma.systemEvent.deleteMany();
    await prisma.storageOperation.deleteMany();
    await prisma.fileReplica.deleteMany();
    await prisma.file.deleteMany();
    await prisma.uploadChunk.deleteMany();
    await prisma.uploadSession.deleteMany();
    await prisma.folder.deleteMany();
    await prisma.user.deleteMany();
    await prisma.storageNode.deleteMany();
    await app.storageMetadata.refreshRegistry(app.storageNodes);
  });

  afterAll(async () => { await app?.close(); await prisma.$disconnect(); if (tempRoot) await rm(tempRoot, { recursive: true, force: true }); });

  it('uses real PostgreSQL for registration, login, ownership and upload-session isolation', async () => {
    const first = await register('USER@example.com');
    expect(first.response.statusCode).toBe(201);
    expect((await register('user@example.com')).response.statusCode).toBe(409);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'password123' } });
    expect(login.statusCode).toBe(200);
    const second = await register('second@example.com');
    const content = Buffer.from('private upload session');
    const created = await app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: first.cookie }, payload: { folderId: null, name: 'private.bin', mimeType: 'application/octet-stream', sizeBytes: content.length, fileChecksum: createHash('sha256').update(content).digest('hex') } });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: `/api/uploads/${created.json().upload.id}`, headers: { cookie: second.cookie } })).statusCode).toBe(404);
    const privateFile = await upload(first.cookie, Buffer.from('private file'), 'private.txt');
    expect(privateFile.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: `/api/files/${privateFile.json().id}/download`, headers: { cookie: second.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/files/${privateFile.json().id}`, headers: { cookie: second.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/folders', headers: { cookie: first.cookie } })).statusCode).toBe(200);
  });

  it('protects monitoring with persisted ADMIN authorization and same-origin demo CSRF checks', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/monitoring/overview' })).statusCode).toBe(401);
    const user = await register('monitor-admin@example.com');
    expect((await app.inject({ method: 'GET', url: '/api/monitoring/overview', headers: { cookie: user.cookie } })).statusCode).toBe(403);
    await prisma.user.update({ where: { email: 'monitor-admin@example.com' }, data: { role: 'ADMIN' } });
    const overview = await app.inject({ method: 'GET', url: '/api/monitoring/overview', headers: { cookie: user.cookie } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ coordinator: { status: 'HEALTHY', database: 'HEALTHY' }, demoActionsEnabled: false });
    expect(overview.json().nodes).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: '/api/monitoring/actions/scrub', headers: { cookie: user.cookie, origin: app.config.WEB_ORIGIN, 'x-csrf-protection': '1' } })).statusCode).toBe(404);
    app.config.DEMO_MODE = true;
    expect((await app.inject({ method: 'POST', url: '/api/monitoring/actions/scrub', headers: { cookie: user.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/monitoring/actions/scrub', headers: { cookie: user.cookie, origin: app.config.WEB_ORIGIN, 'x-csrf-protection': '1' } })).statusCode).toBe(200);
    app.config.DEMO_MODE = false;
  });

  it('limits active upload sessions per user', async () => {
    const user = await register('session-limit@example.com');
    const checksum = createHash('sha256').update(Buffer.from('x')).digest('hex');
    for (let index = 0; index < app.config.MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER; index++) {
      const response = await app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: user.cookie }, payload: { folderId: null, name: `pending-${index}.bin`, mimeType: 'application/octet-stream', sizeBytes: 1, fileChecksum: checksum, clientUploadId: `limit-${index}`, lastModified: index } });
      expect(response.statusCode).toBe(201);
    }
    const rejected = await app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: user.cookie }, payload: { folderId: null, name: 'one-too-many.bin', mimeType: 'application/octet-stream', sizeBytes: 1, fileChecksum: checksum, clientUploadId: 'limit-rejected', lastModified: 999 } });
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json().error.code).toBe('UPLOAD_SESSION_LIMIT');
  });

  it('publishes exactly two HEALTHY replicas to two independent HTTP storage nodes', async () => {
    const user = await register('replicas@example.com');
    const content = Buffer.from('two independent replicas');
    const response = await upload(user.cookie, content);
    expect(response.statusCode).toBe(201);
    const file = await prisma.file.findUniqueOrThrow({ where: { id: response.json().id }, include: { replicas: true } });
    expect(file.status).toBe(FileStatus.AVAILABLE);
    expect(file.replicas).toHaveLength(2);
    expect(new Set(file.replicas.map(replica => replica.nodeId)).size).toBe(2);
    expect(file.replicas.every(replica => replica.status === ReplicaStatus.HEALTHY)).toBe(true);
    for (const replica of file.replicas) {
      const head = await nodeRequest(replica.nodeId, `/objects/${replica.storageKey}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(Number(head.headers.get('content-length'))).toBe(content.length);
      expect(head.headers.get('x-object-sha256')).toBe(createHash('sha256').update(content).digest('hex'));
    }
  });

  it('completes a resumable upload and repeated finalize never duplicates metadata', async () => {
    const user = await register('chunks@example.com');
    const content = Buffer.from('hello chunked world');
    const digest = createHash('sha256').update(content).digest('hex');
    const created = await app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: user.cookie }, payload: { folderId: null, name: 'chunked.txt', mimeType: 'text/plain', sizeBytes: content.length, fileChecksum: digest } });
    const session = created.json().upload;
    for (let index = session.totalChunks - 1; index >= 0; index--) {
      const chunk = content.subarray(index * session.chunkSizeBytes, Math.min((index + 1) * session.chunkSizeBytes, content.length));
      const result = await app.inject({ method: 'PUT', url: `/api/uploads/${session.id}/chunks/${index}`, headers: { cookie: user.cookie, 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update(chunk).digest('hex') }, payload: chunk });
      expect(result.statusCode).toBe(200);
    }
    const completed = await app.inject({ method: 'POST', url: `/api/uploads/${session.id}/complete`, headers: { cookie: user.cookie } });
    expect(completed.statusCode).toBe(200);
    const repeated = await app.inject({ method: 'POST', url: `/api/uploads/${session.id}/complete`, headers: { cookie: user.cookie } });
    expect(repeated.statusCode).toBe(404);
    expect(await prisma.file.count({ where: { owner: { email: 'chunks@example.com' } } })).toBe(1);
    expect(await prisma.fileReplica.count({ where: { fileId: completed.json().file.id } })).toBe(2);
  });

  it('deletes physical replicas and metadata through durable delete operations', async () => {
    const user = await register('delete@example.com');
    const uploaded = await upload(user.cookie);
    const replicas = await prisma.fileReplica.findMany({ where: { fileId: uploaded.json().id } });
    expect((await app.inject({ method: 'DELETE', url: `/api/files/${uploaded.json().id}`, headers: { cookie: user.cookie } })).statusCode).toBe(204);
    expect(await prisma.file.findUnique({ where: { id: uploaded.json().id } })).toBeNull();
    for (const replica of replicas) expect((await nodeRequest(replica.nodeId, `/objects/${replica.storageKey}`, { method: 'HEAD' })).status).toBe(404);
  });

  it.runIf(runDockerFaults)('falls back across real stopped containers, returns 503 when both stop, and recovers', async () => {
    const user = await register('faults@example.com');
    const content = Buffer.from('survives a storage node outage');
    const uploaded = await upload(user.cookie, content);
    const replicas = await prisma.fileReplica.findMany({ where: { fileId: uploaded.json().id } });
    const primary = replicas.find(replica => replica.role === 'PRIMARY')!;
    const backup = replicas.find(replica => replica.role === 'REPLICA')!;

    compose('stop', serviceFor(primary.nodeId));
    await app.storageMetadata.refreshRegistry(app.storageNodes);
    let downloaded = await app.inject({ method: 'GET', url: `/api/files/${uploaded.json().id}/download`, headers: { cookie: user.cookie } });
    expect(downloaded.statusCode).toBe(200);
    expect(createHash('sha256').update(downloaded.rawPayload).digest('hex')).toBe(createHash('sha256').update(content).digest('hex'));

    compose('start', serviceFor(primary.nodeId)); await waitHealthy(primary.nodeId);
    compose('stop', serviceFor(backup.nodeId));
    await app.storageMetadata.refreshRegistry(app.storageNodes);
    downloaded = await app.inject({ method: 'GET', url: `/api/files/${uploaded.json().id}/download`, headers: { cookie: user.cookie } });
    expect(downloaded.statusCode).toBe(200);

    compose('stop', serviceFor(primary.nodeId));
    await app.storageMetadata.refreshRegistry(app.storageNodes);
    const unavailable = await app.inject({ method: 'GET', url: `/api/files/${uploaded.json().id}/download`, headers: { cookie: user.cookie } });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe('FILE_UNAVAILABLE');
    expect(await prisma.file.findUnique({ where: { id: uploaded.json().id } })).not.toBeNull();

    compose('start', serviceFor(primary.nodeId)); await waitHealthy(primary.nodeId);
    await app.storageMetadata.refreshRegistry(app.storageNodes);
    expect((await app.inject({ method: 'GET', url: `/api/files/${uploaded.json().id}/download`, headers: { cookie: user.cookie } })).statusCode).toBe(200);
  });

  it('persists partial replication truth and reconciles a RUNNING operation after restart semantics', async () => {
    const user = await register('partial@example.com');
    const selected = await app.storageMetadata.chooseNodes(2);
    expect(selected).toHaveLength(2);
    await injectWriteFailure(selected[1]!.id, 1);
    const response = await upload(user.cookie, Buffer.from('partial replication'));
    expect(response.statusCode).toBe(503);
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'partial@example.com' } });
    const file = await prisma.file.findFirstOrThrow({ where: { ownerId: owner.id }, include: { replicas: true, operations: true } });
    expect(file.status).toBe(FileStatus.PENDING);
    expect(file.replicas.filter(replica => replica.status === ReplicaStatus.HEALTHY)).toHaveLength(1);
    expect(file.replicas.filter(replica => replica.status === ReplicaStatus.UNAVAILABLE)).toHaveLength(1);
    const failed = file.operations.find(operation => operation.status === StorageOperationStatus.FAILED)!;
    await prisma.storageOperation.update({ where: { id: failed.id }, data: { status: StorageOperationStatus.RUNNING } });
    await app.storageOperations.reconcileIncomplete();
    const recovered = await prisma.file.findUniqueOrThrow({ where: { id: file.id }, include: { replicas: true, operations: true } });
    expect(recovered.status).toBe(FileStatus.AVAILABLE);
    expect(recovered.replicas.every(replica => replica.status === ReplicaStatus.HEALTHY)).toBe(true);
    expect(recovered.operations.every(operation => operation.status === StorageOperationStatus.DONE)).toBe(true);
  });

  it.runIf(runDockerFaults)('never returns corrupted primary bytes and automatically repairs from the healthy replica', async () => {
    const user = await register('corrupt-primary@example.com');
    const content = Buffer.from('authoritative bytes survive corruption');
    const expected = createHash('sha256').update(content).digest('hex');
    const uploaded = await upload(user.cookie, content, 'integrity.bin');
    const primary = await prisma.fileReplica.findFirstOrThrow({ where: { fileId: uploaded.json().id, role: 'PRIMARY' } });
    await corruptObject(primary.nodeId, primary.storageKey);

    const downloaded = await app.inject({ method: 'GET', url: `/api/files/${uploaded.json().id}/download`, headers: { cookie: user.cookie } });
    expect(downloaded.statusCode).toBe(200);
    expect(createHash('sha256').update(downloaded.rawPayload).digest('hex')).toBe(expected);
    expect((await prisma.fileReplica.findUniqueOrThrow({ where: { id: primary.id } })).status).toBe(ReplicaStatus.CORRUPT);

    await app.storageOperations.reconcileRepairs(0, 10);
    const repaired = await prisma.fileReplica.findMany({ where: { fileId: uploaded.json().id } });
    expect(repaired).toHaveLength(2);
    expect(repaired.every(replica => replica.status === ReplicaStatus.HEALTHY)).toBe(true);
    expect(await objectChecksum(primary.nodeId, primary.storageKey)).toBe(expected);
  });

  it.runIf(runDockerFaults)('scrubs a missing replica and restores it without creating duplicate metadata', async () => {
    const user = await register('missing-replica@example.com');
    const content = Buffer.from('restore a physically missing replica');
    const expected = createHash('sha256').update(content).digest('hex');
    const uploaded = await upload(user.cookie, content);
    const target = await prisma.fileReplica.findFirstOrThrow({ where: { fileId: uploaded.json().id, role: 'PRIMARY' } });
    await nodeRequest(target.nodeId, `/objects/${target.storageKey}`, { method: 'DELETE' });
    await prisma.fileReplica.update({ where: { id: target.id }, data: { lastVerifiedAt: null } });

    expect(await app.scrubber.tick(1)).toEqual({ checked: 1, failed: 1 });
    expect((await prisma.fileReplica.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(ReplicaStatus.MISSING);
    await app.storageOperations.reconcileRepairs(0, 10);
    expect(await prisma.fileReplica.count({ where: { fileId: uploaded.json().id } })).toBe(2);
    expect(await prisma.fileReplica.count({ where: { fileId: uploaded.json().id, status: ReplicaStatus.HEALTHY } })).toBe(2);
    expect(await objectChecksum(target.nodeId, target.storageKey)).toBe(expected);
  });

  it.runIf(runDockerFaults)('recovers a RUNNING repair after coordinator restart without a third healthy replica', async () => {
    const user = await register('repair-restart@example.com');
    const uploaded = await upload(user.cookie, Buffer.from('repair survives coordinator restart'));
    const target = await prisma.fileReplica.findFirstOrThrow({ where: { fileId: uploaded.json().id, role: 'PRIMARY' } });
    await corruptObject(target.nodeId, target.storageKey);
    await prisma.fileReplica.update({ where: { id: target.id }, data: { lastVerifiedAt: null } });
    await app.scrubber.tick(1);
    const operation = await prisma.storageOperation.findFirstOrThrow({ where: { replicaId: target.id, type: 'REPAIR_REPLICA' } });
    await prisma.storageOperation.update({ where: { id: operation.id }, data: { status: StorageOperationStatus.RUNNING } });

    await app.close();
    app = await buildTestApp();
    await app.storageMetadata.refreshRegistry(app.storageNodes);
    await app.storageOperations.reconcileIncomplete();

    expect((await prisma.storageOperation.findUniqueOrThrow({ where: { id: operation.id } })).status).toBe(StorageOperationStatus.DONE);
    expect(await prisma.fileReplica.count({ where: { fileId: uploaded.json().id, status: ReplicaStatus.HEALTHY } })).toBe(2);
    expect(await prisma.fileReplica.count({ where: { fileId: uploaded.json().id } })).toBe(2);
  });

  it.runIf(runDockerFaults)('returns 503 and preserves CORRUPT metadata when both replicas are damaged', async () => {
    const user = await register('both-corrupt@example.com');
    const uploaded = await upload(user.cookie, Buffer.from('no trustworthy copy remains'));
    const replicas = await prisma.fileReplica.findMany({ where: { fileId: uploaded.json().id } });
    for (const replica of replicas) await corruptObject(replica.nodeId, replica.storageKey);
    const downloaded = await app.inject({ method: 'GET', url: `/api/files/${uploaded.json().id}/download`, headers: { cookie: user.cookie } });
    expect(downloaded.statusCode).toBe(503);
    expect(downloaded.json().error.code).toBe('FILE_UNAVAILABLE');
    expect(await prisma.fileReplica.count({ where: { fileId: uploaded.json().id, status: ReplicaStatus.CORRUPT } })).toBe(2);
    expect(await prisma.file.findUnique({ where: { id: uploaded.json().id } })).not.toBeNull();
  });

  it.runIf(runDockerFaults)('resumes a 100 MiB upload after coordinator restart and accepts concurrent duplicate resume safely', async () => {
    const user = await register('persistent-resume@example.com');
    const content = Buffer.alloc(100 * 1024 * 1024, 0x5a);
    const digest = createHash('sha256').update(content).digest('hex');
    const clientUploadId = `${digest}:${content.length}:1234:large.bin`;
    const payload = { folderId: null, name: 'large.bin', mimeType: 'application/octet-stream', sizeBytes: content.length, fileChecksum: digest, clientUploadId, lastModified: 1234 };
    const created = await app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: user.cookie }, payload });
    const session = created.json().upload;
    const putChunk = (index: number) => {
      const chunk = content.subarray(index * session.chunkSizeBytes, Math.min((index + 1) * session.chunkSizeBytes, content.length));
      return app.inject({ method: 'PUT', url: `/api/uploads/${session.id}/chunks/${index}`, headers: { cookie: user.cookie, 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update(chunk).digest('hex') }, payload: chunk });
    };
    for (let index = 0; index < 6; index++) expect((await putChunk(index)).statusCode).toBe(200);
    const duplicates = await Promise.all([putChunk(6), putChunk(6)]);
    expect(duplicates.map(result => result.statusCode)).toEqual([200, 200]);
    expect(await prisma.uploadChunk.count({ where: { uploadSessionId: session.id } })).toBe(7);

    await app.close();
    app = await buildTestApp();
    const resumed = await app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: user.cookie }, payload });
    expect(resumed.json().upload.id).toBe(session.id);
    expect(resumed.json().upload.completedChunks.map((chunk: { chunkIndex: number }) => chunk.chunkIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (let index = 7; index < session.totalChunks; index++) expect((await putChunk(index)).statusCode).toBe(200);
    const completed = await app.inject({ method: 'POST', url: `/api/uploads/${session.id}/complete`, headers: { cookie: user.cookie } });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().file.checksum).toBe(digest);
    expect(await prisma.file.count({ where: { owner: { email: 'persistent-resume@example.com' } } })).toBe(1);
  }, 120_000);

  it('garbage-collects expired active uploads without deleting completed files', async () => {
    const user = await register('upload-gc@example.com');
    const completed = await upload(user.cookie, Buffer.from('keep completed file'));
    const content = Buffer.from('abandoned chunk data');
    const created = await app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: user.cookie }, payload: { folderId: null, name: 'abandoned.bin', mimeType: 'application/octet-stream', sizeBytes: content.length, fileChecksum: createHash('sha256').update(content).digest('hex'), clientUploadId: 'abandoned-upload', lastModified: 5 } });
    const session = created.json().upload;
    const firstChunk = content.subarray(0, Math.min(session.chunkSizeBytes, content.length));
    expect((await app.inject({ method: 'PUT', url: `/api/uploads/${session.id}/chunks/0`, headers: { cookie: user.cookie, 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update(firstChunk).digest('hex') }, payload: firstChunk })).statusCode).toBe(200);
    await prisma.uploadSession.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } });
    expect(await cleanupExpiredUploads(app.storage, app.log)).toBe(1);
    expect(await prisma.uploadSession.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await app.storage.chunkExists(session.id, 0)).toBe(false);
    expect(await prisma.file.findUnique({ where: { id: completed.json().id } })).not.toBeNull();
  });

  it.runIf(runDockerFaults)('persists heartbeat UNAVAILABLE and HEALTHY transitions', async () => {
    compose('stop', 'storage-test-a');
    await app.storageMetadata.refreshRegistry(app.storageNodes);
    expect((await prisma.storageNode.findUniqueOrThrow({ where: { id: 'node-a' } })).status).toBe(StorageNodeStatus.UNAVAILABLE);
    compose('start', 'storage-test-a'); await waitHealthy('node-a');
    await app.storageMetadata.refreshRegistry(app.storageNodes);
    const restored = await prisma.storageNode.findUniqueOrThrow({ where: { id: 'node-a' } });
    expect(restored.status).toBe(StorageNodeStatus.HEALTHY);
    expect(restored.lastHeartbeatAt).not.toBeNull();
  });
});
