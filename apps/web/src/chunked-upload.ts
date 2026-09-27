import axios from 'axios';
import { createSHA256, sha256 } from 'hash-wasm';
import {
  CHUNK_SIZE_BYTES,
  MAX_PARALLEL_CHUNKS,
  MAX_UPLOAD_FILE_SIZE,
  type CreateUploadSessionResponse,
  type FileDto,
  type UploadSessionDto,
} from '@depot-drive/shared';
import { api, fileTooLargeMessage, UserFacingError } from './api';

export type UploadPhase = 'hashing' | 'uploading' | 'paused' | 'completing' | 'complete' | 'cancelled' | 'failed';
export interface ChunkedUploadProgress {
  phase: UploadPhase;
  loadedBytes: number;
  totalBytes: number;
  uploadedChunks: number;
  totalChunks: number;
  activeWorkers: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
}
export interface ChunkedUploadTask {
  promise: Promise<FileDto>;
  pause(): void;
  resume(): void;
  cancel(): Promise<void>;
}
export interface PersistedUpload {
  clientUploadId: string;
  uploadId: string;
  name: string;
  sizeBytes: number;
  lastModified: number;
  fileChecksum: string;
  updatedAt: string;
}
const uploadStoragePrefix = 'depot-drive:upload:v1:';
const storageAvailable = () => typeof localStorage !== 'undefined';
export function uploadIdentity(file: Pick<File, 'name' | 'size' | 'lastModified'>, checksum: string) {
  return `${checksum.toLowerCase()}:${file.size}:${file.lastModified}:${file.name}`;
}
function persistedKey(clientUploadId: string) { return `${uploadStoragePrefix}${clientUploadId}`; }
export function listPersistedUploads(): PersistedUpload[] {
  if (!storageAvailable()) return [];
  const records: PersistedUpload[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(uploadStoragePrefix)) continue;
    try { records.push(JSON.parse(localStorage.getItem(key) ?? '') as PersistedUpload); } catch { localStorage.removeItem(key); }
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function persistUpload(record: PersistedUpload) { if (storageAvailable()) localStorage.setItem(persistedKey(record.clientUploadId), JSON.stringify(record)); }
export function forgetUpload(clientUploadId: string) { if (storageAvailable()) localStorage.removeItem(persistedKey(clientUploadId)); }
export function uploadActionsForPhase(phase: UploadPhase): Array<'pause' | 'resume' | 'cancel'> {
  if (phase === 'uploading') return ['pause', 'cancel'];
  if (phase === 'paused') return ['resume', 'cancel'];
  if (phase === 'hashing' || phase === 'completing') return ['cancel'];
  return [];
}

interface SpeedSample { at: number; bytes: number }
export function calculateTransferMetrics(samples: SpeedSample[], totalBytes: number, now = Date.now()) {
  const recent = samples.filter(sample => now - sample.at <= 10_000);
  if (recent.length < 2) return {};
  const first = recent[0]!;
  const last = recent.at(-1)!;
  const seconds = (last.at - first.at) / 1_000;
  const speedBytesPerSecond = seconds > 0 ? Math.max(0, (last.bytes - first.bytes) / seconds) : 0;
  if (speedBytesPerSecond <= 0) return {};
  return { speedBytesPerSecond, etaSeconds: Math.max(0, (totalBytes - last.bytes) / speedBytesPerSecond) };
}

export function validateUploadFileSize(sizeBytes: number): void {
  if (sizeBytes > MAX_UPLOAD_FILE_SIZE) throw new UserFacingError(fileTooLargeMessage());
}

function abortError(message: string) { return new DOMException(message, 'AbortError'); }
function isAbort(error: unknown) { return axios.isCancel(error) || (error as { name?: string } | null)?.name === 'AbortError'; }
function retryable(error: unknown) {
  if (!axios.isAxiosError(error) || isAbort(error)) return false;
  return !error.response || (error.response.status >= 500 && error.response.status <= 599);
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError('Upload interrupted'));
    const timer = globalThis.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { globalThis.clearTimeout(timer); reject(abortError('Upload interrupted')); }, { once: true });
  });
}

async function hashFile(file: File, onProgress: (loaded: number) => void, signal: AbortSignal) {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE_BYTES) {
    if (signal.aborted) throw abortError('Upload cancelled');
    const bytes = new Uint8Array(await file.slice(offset, Math.min(offset + CHUNK_SIZE_BYTES, file.size)).arrayBuffer());
    hasher.update(bytes);
    onProgress(Math.min(offset + bytes.byteLength, file.size));
  }
  if (file.size === 0) hasher.update(new Uint8Array());
  return hasher.digest('hex');
}

export function startChunkedUpload(options: { file: File; folderId: string | null; onProgress: (progress: ChunkedUploadProgress) => void }): ChunkedUploadTask {
  const { file, folderId, onProgress } = options;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE_BYTES);
  let uploadId: string | undefined;
  let clientUploadId: string | undefined;
  let session: UploadSessionDto | undefined;
  let roundController = new AbortController();
  let paused = false;
  let cancelled = false;
  let terminal = false;
  let wakeResume: (() => void) | undefined;
  let completedSizes = new Map<number, number>();
  let inFlightSizes = new Map<number, number>();
  let samples: SpeedSample[] = [];
  let activeWorkers = 0;

  const completedBytes = () => Array.from(completedSizes.values()).reduce((sum, size) => sum + size, 0);
  const emit = (phase: UploadPhase, includeInFlight = true) => {
    const loadedBytes = completedBytes() + (includeInFlight ? Array.from(inFlightSizes.values()).reduce((sum, size) => sum + size, 0) : 0);
    if (phase === 'uploading') {
      const now = Date.now();
      samples.push({ at: now, bytes: loadedBytes });
      samples = samples.filter(sample => now - sample.at <= 10_000);
    }
    onProgress({ phase, loadedBytes, totalBytes: file.size, uploadedChunks: completedSizes.size, totalChunks: session?.totalChunks ?? totalChunks, activeWorkers, ...(phase === 'uploading' ? calculateTransferMetrics(samples, file.size) : {}) });
  };

  try {
    validateUploadFileSize(file.size);
  } catch (error) {
    onProgress({ phase: 'failed', loadedBytes: 0, totalBytes: file.size, uploadedChunks: 0, totalChunks, activeWorkers: 0 });
    return { promise: Promise.reject(error), pause() {}, resume() {}, async cancel() {} };
  }

  async function uploadChunk(index: number, activeSession: UploadSessionDto, signal: AbortSignal) {
    const start = index * activeSession.chunkSizeBytes;
    const blob = file.slice(start, Math.min(start + activeSession.chunkSizeBytes, file.size));
    const checksum = await sha256(new Uint8Array(await blob.arrayBuffer()));
    const delays = [500, 1_000, 2_000];
    for (let attempt = 0; ; attempt++) {
      if (paused || cancelled || signal.aborted) throw abortError('Upload interrupted');
      try {
        await api.put(`/api/uploads/${activeSession.id}/chunks/${index}`, blob, {
          signal,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': checksum },
          onUploadProgress: event => {
            if (!paused && !cancelled && !signal.aborted) {
              inFlightSizes.set(index, Math.min(event.loaded, blob.size));
              emit('uploading');
            }
          },
        });
        inFlightSizes.delete(index);
        completedSizes.set(index, blob.size);
        emit('uploading');
        return;
      } catch (error) {
        inFlightSizes.delete(index);
        if (!retryable(error) || attempt >= delays.length) throw error;
        await wait(delays[attempt]!, signal);
      }
    }
  }

  async function uploadRound(activeSession: UploadSessionDto) {
    const missing = Array.from({ length: activeSession.totalChunks }, (_, index) => index).filter(index => !completedSizes.has(index));
    let cursor = 0;
    roundController = new AbortController();
    const signal = roundController.signal;
    async function worker() {
      while (true) {
        if (paused || cancelled || signal.aborted) throw abortError('Upload interrupted');
        const index = missing[cursor++];
        if (index === undefined) return;
        activeWorkers++;
        emit('uploading');
        try { await uploadChunk(index, activeSession, signal); }
        finally { activeWorkers--; if (!paused && !cancelled) emit('uploading'); }
      }
    }
    emit('uploading');
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_CHUNKS, Math.max(1, missing.length)) }, () => worker()));
  }

  const promise = (async () => {
    onProgress({ phase: 'hashing', loadedBytes: 0, totalBytes: file.size, uploadedChunks: 0, totalChunks, activeWorkers: 0 });
    const fileChecksum = await hashFile(file, loadedBytes => onProgress({ phase: 'hashing', loadedBytes, totalBytes: file.size, uploadedChunks: 0, totalChunks, activeWorkers: 0 }), roundController.signal);
    if (cancelled) throw abortError('Upload cancelled');
    clientUploadId = uploadIdentity(file, fileChecksum);
    const created = await api.post<CreateUploadSessionResponse>('/api/uploads', { folderId, name: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, fileChecksum, clientUploadId, lastModified: file.lastModified }, { signal: roundController.signal });
    session = created.data.upload;
    uploadId = session.id;
    persistUpload({ clientUploadId, uploadId, name: file.name, sizeBytes: file.size, lastModified: file.lastModified, fileChecksum, updatedAt: new Date().toISOString() });
    completedSizes = new Map(session.completedChunks.map(chunk => [chunk.chunkIndex, chunk.sizeBytes]));

    while (true) {
      if (cancelled) throw abortError('Upload cancelled');
      if (paused) {
        inFlightSizes.clear();
        samples = [];
        emit('paused', false);
        await new Promise<void>(resolve => { wakeResume = resolve; });
        wakeResume = undefined;
        if (cancelled) throw abortError('Upload cancelled');
        session = (await api.get<CreateUploadSessionResponse>(`/api/uploads/${uploadId}`)).data.upload;
        completedSizes = new Map(session.completedChunks.map(chunk => [chunk.chunkIndex, chunk.sizeBytes]));
        inFlightSizes.clear();
        samples = [];
      }
      try {
        await uploadRound(session);
        break;
      } catch (error) {
        if (paused && isAbort(error)) continue;
        throw error;
      }
    }

    emit('completing', false);
    const response = await api.post<{ file: FileDto }>(`/api/uploads/${session.id}/complete`, undefined, { signal: roundController.signal });
    if (clientUploadId) forgetUpload(clientUploadId);
    terminal = true;
    onProgress({ phase: 'complete', loadedBytes: file.size, totalBytes: file.size, uploadedChunks: session.totalChunks, totalChunks: session.totalChunks, activeWorkers: 0 });
    return response.data.file;
  })().catch(error => {
    terminal = true;
    if (cancelled) onProgress({ phase: 'cancelled', loadedBytes: 0, totalBytes: file.size, uploadedChunks: 0, totalChunks, activeWorkers: 0 });
    else if (!paused) onProgress({ phase: 'failed', loadedBytes: completedBytes(), totalBytes: file.size, uploadedChunks: completedSizes.size, totalChunks: session?.totalChunks ?? totalChunks, activeWorkers: 0 });
    throw error;
  });

  return {
    promise,
    pause() {
      if (terminal || cancelled || paused || !session) return;
      paused = true;
      roundController.abort();
      inFlightSizes.clear();
      samples = [];
      emit('paused', false);
    },
    resume() {
      if (terminal || cancelled || !paused) return;
      paused = false;
      samples = [];
      wakeResume?.();
    },
    async cancel() {
      if (terminal || cancelled) return;
      cancelled = true;
      paused = false;
      roundController.abort();
      wakeResume?.();
      if (uploadId) await api.delete(`/api/uploads/${uploadId}`).catch(() => undefined);
      if (clientUploadId) forgetUpload(clientUploadId);
    },
  };
}
