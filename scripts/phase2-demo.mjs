import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const api = 'http://127.0.0.1:3000';
const data = Buffer.alloc(100 * 1024 * 1024, 0x5a);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const expectedSha256 = sha256(data);
const email = `phase2-${Date.now()}@example.com`;
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL ?? 'postgresql://depot:depot@127.0.0.1:5432/depot_drive' } } });
const compose = (...args) => execFileSync('docker', ['compose', ...args], { cwd: process.cwd(), stdio: 'pipe' }).toString().trim();
const log = (step, details = {}) => console.log(JSON.stringify({ step, ...details }));

async function waitFor(label, check, attempts = 120, delayMs = 500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { const result = await check(); if (result) return result; } catch { /* retry transient state */ }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function createSession(headers, name, clientUploadId) {
  const response = await fetch(`${api}/api/uploads`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: null, name, mimeType: 'application/octet-stream', sizeBytes: data.length, fileChecksum: expectedSha256, clientUploadId, lastModified: 123456789 }) });
  if (response.status !== 201) throw new Error(`Session creation failed: ${response.status} ${await response.text()}`);
  return (await response.json()).upload;
}

async function uploadIndices(headers, session, indices) {
  const sent = [];
  for (let offset = 0; offset < indices.length; offset += 4) {
    await Promise.all(indices.slice(offset, offset + 4).map(async index => {
      const chunk = data.subarray(index * session.chunkSizeBytes, Math.min((index + 1) * session.chunkSizeBytes, data.length));
      const response = await fetch(`${api}/api/uploads/${session.id}/chunks/${index}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': sha256(chunk) }, body: chunk });
      if (!response.ok) throw new Error(`Chunk ${index} failed: ${response.status} ${await response.text()}`);
      sent.push(index);
    }));
  }
  return sent.sort((a, b) => a - b);
}

async function complete(headers, session) {
  const response = await fetch(`${api}/api/uploads/${session.id}/complete`, { method: 'POST', headers });
  if (!response.ok) throw new Error(`Finalize failed: ${response.status} ${await response.text()}`);
  return (await response.json()).file;
}

async function download(headers, fileId) {
  const response = await fetch(`${api}/api/files/${fileId}/download`, { headers });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${await response.text()}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expectedSha256) throw new Error(`Downloaded corrupt content: ${actual}`);
  return { bytes: bytes.length, sha256: actual };
}

function objectPath(storageKey) { return `/data/objects/${storageKey.slice(0, 2)}/${storageKey.slice(2, 4)}/${storageKey}`; }
function containerFor(nodeId) { return compose('ps', '-q', nodeId === 'node-a' ? 'storage-node-a' : 'storage-node-b'); }
function corrupt(container, path) {
  execFileSync('docker', ['exec', container, 'node', '-e', "const fs=require('fs');const p=process.argv[1];const fd=fs.openSync(p,'r+');const b=Buffer.alloc(1);fs.readSync(fd,b,0,1,0);b[0]^=255;fs.writeSync(fd,b,0,1,0);fs.closeSync(fd)", path]);
}
function objectHash(container, path) {
  return execFileSync('docker', ['exec', container, 'node', '-e', "const fs=require('fs'),c=require('crypto');const h=c.createHash('sha256');const s=fs.createReadStream(process.argv[1]);s.on('data',d=>h.update(d));s.on('end',()=>console.log(h.digest('hex')))", path]).toString().trim();
}

async function main() {
  await waitFor('API', async () => (await fetch(`${api}/health`)).ok);
  const registered = await fetch(`${api}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
  if (registered.status !== 201) throw new Error(`Registration failed: ${registered.status} ${await registered.text()}`);
  const cookie = registered.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Registration did not return a cookie');
  const headers = { Cookie: cookie };

  const first = await createSession(headers, 'phase2-integrity-100mb.bin', `integrity:${expectedSha256}:${Date.now()}`);
  await uploadIndices(headers, first, Array.from({ length: first.totalChunks }, (_, index) => index));
  const file = await complete(headers, first);
  const replicas = await prisma.fileReplica.findMany({ where: { fileId: file.id }, orderBy: { nodeId: 'asc' } });
  if (replicas.length !== 2 || replicas.some(replica => replica.status !== 'HEALTHY')) throw new Error('Upload did not create two healthy replicas');
  for (const replica of replicas) if (objectHash(containerFor(replica.nodeId), objectPath(replica.storageKey)) !== expectedSha256) throw new Error(`Initial replica ${replica.nodeId} checksum mismatch`);
  log('two_replicas_verified', { fileId: file.id, replicas: replicas.map(replica => ({ nodeId: replica.nodeId, status: replica.status })), sha256: expectedSha256 });

  const target = replicas.find(replica => replica.nodeId === 'node-a') ?? replicas[0];
  corrupt(containerFor(target.nodeId), objectPath(target.storageKey));
  log('replica_corrupted', { nodeId: target.nodeId, replicaId: target.id });
  const fallbackDownload = download(headers, file.id);
  const corruptState = await waitFor('CORRUPT replica state', async () => {
    const current = await prisma.fileReplica.findUnique({ where: { id: target.id } });
    return current?.status === 'CORRUPT' ? current : false;
  }, 600, 10);
  log('corruption_detected', { replicaId: target.id, status: corruptState.status });
  log('healthy_fallback_download', await fallbackDownload);

  await waitFor('automatic replica repair', async () => {
    const current = await prisma.fileReplica.findUnique({ where: { id: target.id } });
    return current?.status === 'HEALTHY' && objectHash(containerFor(target.nodeId), objectPath(target.storageKey)) === expectedSha256;
  });
  const healthyCount = await prisma.fileReplica.count({ where: { fileId: file.id, status: 'HEALTHY' } });
  if (healthyCount !== 2) throw new Error(`Expected two healthy replicas after repair, got ${healthyCount}`);
  log('automatic_repair_complete', { healthyReplicas: healthyCount, repairedSha256: expectedSha256 });

  const resumeId = `resume:${expectedSha256}:${Date.now()}`;
  const partial = await createSession(headers, 'phase2-resume-100mb.bin', resumeId);
  const split = Math.ceil(partial.totalChunks / 2);
  const beforeRestart = Array.from({ length: split }, (_, index) => index);
  await uploadIndices(headers, partial, beforeRestart);
  log('upload_interrupted', { uploadId: partial.id, completedChunks: beforeRestart, totalChunks: partial.totalChunks });
  compose('restart', 'api');
  await waitFor('restarted API', async () => (await fetch(`${api}/health`)).ok);
  const resumed = await createSession(headers, 'phase2-resume-100mb.bin', resumeId);
  if (resumed.id !== partial.id) throw new Error('API restart lost the upload session identity');
  const completedSet = new Set(resumed.completedChunks.map(chunk => chunk.chunkIndex));
  const missing = Array.from({ length: resumed.totalChunks }, (_, index) => index).filter(index => !completedSet.has(index));
  const sentAfterRestart = await uploadIndices(headers, resumed, missing);
  if (sentAfterRestart.join(',') !== missing.join(',')) throw new Error('Resume sent chunks outside the missing set');
  const resumedFile = await complete(headers, resumed);
  log('upload_resumed_after_api_restart', { uploadId: resumed.id, retainedChunks: [...completedSet].sort((a, b) => a - b), sentAfterRestart, final: await download(headers, resumedFile.id) });
}

try { await main(); }
finally { await prisma.$disconnect(); }
