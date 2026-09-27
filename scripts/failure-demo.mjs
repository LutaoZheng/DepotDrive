import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const api = 'http://127.0.0.1:3000';
const token = process.env.STORAGE_INTERNAL_TOKEN;
if (!token) throw new Error('STORAGE_INTERNAL_TOKEN is required; load it from the local .env before running the demo');
const data = Buffer.alloc(100 * 1024 * 1024, 0x5a);
const originalSha256 = createHash('sha256').update(data).digest('hex');
const email = `phase1-${Date.now()}@example.com`;
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://depot:depot@127.0.0.1:5432/depot_drive' } } });
const compose = (...args) => execFileSync('docker', ['compose', ...args], { cwd: process.cwd(), stdio: 'pipe' }).toString().trim();
const log = (step, details = {}) => console.log(JSON.stringify({ step, ...details }));

async function waitFor(url, options = {}, predicate = response => response.ok) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(url, options); if (await predicate(response)) return; } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  await waitFor(`${api}/health`);
  const registered = await fetch(`${api}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
  if (registered.status !== 201) throw new Error(`Registration failed: ${registered.status} ${await registered.text()}`);
  const cookie = registered.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Registration did not return a session cookie');
  const authHeaders = { Cookie: cookie };
  log('registered', { email });

  const sessionResponse = await fetch(`${api}/api/uploads`, { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: null, name: 'phase1-100mb.bin', mimeType: 'application/octet-stream', sizeBytes: data.length, fileChecksum: originalSha256 }) });
  if (sessionResponse.status !== 201) throw new Error(`Session creation failed: ${sessionResponse.status} ${await sessionResponse.text()}`);
  const session = (await sessionResponse.json()).upload;
  const indices = Array.from({ length: session.totalChunks }, (_, index) => index);
  for (let offset = 0; offset < indices.length; offset += 4) {
    await Promise.all(indices.slice(offset, offset + 4).map(async index => {
      const chunk = data.subarray(index * session.chunkSizeBytes, Math.min((index + 1) * session.chunkSizeBytes, data.length));
      const checksum = createHash('sha256').update(chunk).digest('hex');
      const response = await fetch(`${api}/api/uploads/${session.id}/chunks/${index}`, { method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': checksum }, body: chunk });
      if (!response.ok) throw new Error(`Chunk ${index} failed: ${response.status} ${await response.text()}`);
    }));
  }
  log('uploaded_chunks', { bytes: data.length, chunks: session.totalChunks, parallelism: 4, originalSha256 });

  const completed = await fetch(`${api}/api/uploads/${session.id}/complete`, { method: 'POST', headers: authHeaders });
  if (!completed.ok) throw new Error(`Finalize failed: ${completed.status} ${await completed.text()}`);
  const file = (await completed.json()).file;
  const dbFile = await prisma.file.findUniqueOrThrow({ where: { id: file.id }, include: { replicas: { include: { node: true } } } });
  log('file_available', { fileId: file.id, status: dbFile.status, replicas: dbFile.replicas.map(replica => ({ nodeId: replica.nodeId, status: replica.status, sizeBytes: Number(replica.sizeBytes), sha256: replica.sha256 })) });

  const mountsA = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .Mounts}}', 'depotdrive-storage-node-a-1']).toString());
  const mountsB = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .Mounts}}', 'depotdrive-storage-node-b-1']).toString());
  const volumeA = mountsA.find(mount => mount.Destination === '/data')?.Name;
  const volumeB = mountsB.find(mount => mount.Destination === '/data')?.Name;
  if (!volumeA || !volumeB || volumeA === volumeB) throw new Error('Storage nodes do not have independent volumes');
  for (const replica of dbFile.replicas) {
    const container = replica.nodeId === 'node-a' ? 'depotdrive-storage-node-a-1' : 'depotdrive-storage-node-b-1';
    const key = replica.storageKey;
    execFileSync('docker', ['exec', container, 'test', '-f', `/data/objects/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`]);
  }
  log('independent_volumes_verified', { volumeA, volumeB });

  async function download(expectedStatus = 200) {
    const response = await fetch(`${api}/api/files/${file.id}/download`, { headers: authHeaders });
    if (response.status !== expectedStatus) throw new Error(`Expected download ${expectedStatus}, got ${response.status}: ${await response.text()}`);
    if (expectedStatus !== 200) return { status: response.status, body: await response.json() };
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== originalSha256) throw new Error(`Downloaded checksum mismatch: ${sha256}`);
    return { status: response.status, sha256, bytes: bytes.length };
  }

  compose('stop', 'storage-node-a');
  log('node_a_stopped', await download());

  compose('start', 'storage-node-a');
  await waitFor('http://127.0.0.1:4001/health', { headers: { Authorization: `Bearer ${token}` } });
  await waitFor(`${api}/api/storage/nodes`, { headers: authHeaders }, async response => response.ok && (await response.json()).nodes.find(node => node.id === 'node-a')?.alive);
  compose('stop', 'storage-node-b');
  log('node_b_stopped_node_a_download', await download());

  compose('stop', 'storage-node-a');
  log('both_nodes_stopped', await download(503));

  compose('start', 'storage-node-a');
  await waitFor('http://127.0.0.1:4001/health', { headers: { Authorization: `Bearer ${token}` } });
  await waitFor(`${api}/api/storage/nodes`, { headers: authHeaders }, async response => response.ok && (await response.json()).nodes.find(node => node.id === 'node-a')?.alive);
  log('one_node_restored', await download());

  compose('restart', 'api');
  await waitFor(`${api}/health`);
  log('api_restarted_metadata_persisted', { download: await download(), fileStatus: (await prisma.file.findUniqueOrThrow({ where: { id: file.id } })).status });
}

try { await main(); }
finally {
  try { compose('start', 'storage-node-a', 'storage-node-b', 'api'); } catch { /* leave diagnosis to caller */ }
  await prisma.$disconnect();
}
