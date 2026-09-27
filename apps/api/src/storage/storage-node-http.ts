import { Readable } from 'node:stream';
import type { SaveFileInput } from './file-storage.js';
import type { StorageNode, StorageNodeCapacity, StorageNodeHealth, StorageObjectMetadata } from './storage-node.js';

interface HealthResponse { status: string; capacityBytes: number; usedBytes: number }
interface PutResponse { sizeBytes: number; sha256: string }

export class StorageNodeHttp implements StorageNode {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly endpoint: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  private url(path: string) { return `${this.endpoint.replace(/\/$/, '')}${path}`; }
  private async request(path: string, init: RequestInit = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(this.url(path), { ...init, headers: { Authorization: `Bearer ${this.token}`, ...init.headers }, signal: controller.signal });
    } finally { clearTimeout(timer); }
  }

  async upload(input: SaveFileInput) {
    if (input.expectedSizeBytes === undefined || !input.expectedChecksum) throw new Error('Expected object metadata is required');
    const response = await this.request(`/objects/${input.storageKey}`, {
      method: 'PUT', body: input.stream as never, duplex: 'half',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Object-Size': String(input.expectedSizeBytes), 'X-Object-SHA256': input.expectedChecksum, ...(input.allowReplace ? { 'X-Allow-Replace': 'true' } : {}) },
    } as RequestInit);
    if (!response.ok) throw new Error(`Storage node ${this.id} PUT failed with ${response.status}`);
    const result = await response.json() as PutResponse;
    return { storageKey: input.storageKey, sizeBytes: result.sizeBytes, checksum: result.sha256 };
  }

  async download(storageKey: string) {
    const response = await this.request(`/objects/${storageKey}`);
    if (!response.ok || !response.body) throw new Error(`Storage node ${this.id} GET failed with ${response.status}`);
    return Readable.fromWeb(response.body as never);
  }

  async delete(storageKey: string) {
    const response = await this.request(`/objects/${storageKey}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error(`Storage node ${this.id} DELETE failed with ${response.status}`);
  }

  async metadata(storageKey: string): Promise<StorageObjectMetadata | null> {
    const response = await this.request(`/objects/${storageKey}`, { method: 'HEAD' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Storage node ${this.id} HEAD failed with ${response.status}`);
    const sizeBytes = Number(response.headers.get('content-length'));
    const checksum = response.headers.get('x-object-sha256') ?? '';
    if (!Number.isSafeInteger(sizeBytes) || !/^[a-f0-9]{64}$/i.test(checksum)) throw new Error(`Storage node ${this.id} returned invalid metadata`);
    return { sizeBytes, checksum: checksum.toLowerCase() };
  }

  async exists(storageKey: string) { return (await this.metadata(storageKey)) !== null; }

  private async healthResponse(): Promise<HealthResponse> {
    const response = await this.request('/health');
    if (!response.ok) throw new Error(`Storage node ${this.id} health failed with ${response.status}`);
    return response.json() as Promise<HealthResponse>;
  }

  async health(): Promise<StorageNodeHealth> {
    try { const result = await this.healthResponse(); return { alive: result.status === 'HEALTHY', checkedAt: new Date() }; }
    catch { return { alive: false, checkedAt: new Date() }; }
  }

  async capacity(): Promise<StorageNodeCapacity> {
    const result = await this.healthResponse();
    return { capacityBytes: result.capacityBytes, usedBytes: result.usedBytes };
  }
}
