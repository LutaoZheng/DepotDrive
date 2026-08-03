import { createHash } from 'node:crypto';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE_BYTES, MAX_UPLOAD_FILE_SIZE, type UploadSessionDto } from '@depot-drive/shared';
import { api, parseApiError } from './api';
import { calculateTransferMetrics, startChunkedUpload, uploadActionsForPhase, validateUploadFileSize, type ChunkedUploadProgress } from './chunked-upload';

const id = '11111111-1111-4111-8111-111111111111';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function session(file: File, completedChunks: UploadSessionDto['completedChunks'] = []): UploadSessionDto {
  return { id, folderId: null, name: file.name, mimeType: file.type, sizeBytes: file.size, fileChecksum: '', chunkSizeBytes: 3, totalChunks: Math.ceil(file.size / 3), status: 'ACTIVE', expiresAt: new Date(Date.now() + 10_000).toISOString(), completedChunks };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('chunked upload controls', () => {
  it('exposes Pause and Cancel while uploading, and Resume and Cancel while paused', () => {
    expect(uploadActionsForPhase('uploading')).toEqual(['pause', 'cancel']);
    expect(uploadActionsForPhase('paused')).toEqual(['resume', 'cancel']);
    expect(uploadActionsForPhase('cancelled')).toEqual([]);
  });

  it('pauses in-flight requests without cancelling the session, then resumes only server-missing chunks without resetting progress', async () => {
    const bytes = Buffer.from('abcdefghijkl');
    const file = new File([bytes], 'resume.txt', { type: 'text/plain' });
    const firstChunk = { chunkIndex: 0, sizeBytes: 3, checksum: digest(bytes.subarray(0, 3)) };
    vi.spyOn(api, 'post').mockImplementation(async url => url === '/api/uploads'
      ? { data: { upload: session(file, [firstChunk]) } } as never
      : { data: { file: { id: 'file-id' } } } as never);
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: { upload: session(file, [firstChunk]) } });
    const remove = vi.spyOn(api, 'delete');
    const started: number[] = [];
    let aborted = 0;
    const put = vi.spyOn(api, 'put').mockImplementation((url, _body, config) => new Promise((resolve, reject) => {
      started.push(Number(String(url).split('/').at(-1)));
      config?.signal?.addEventListener?.('abort', () => { aborted++; reject(new DOMException('paused', 'AbortError')); }, { once: true });
      if (get.mock.calls.length > 0) resolve({ data: {} });
    }));
    const progress: ChunkedUploadProgress[] = [];
    const task = startChunkedUpload({ file, folderId: null, onProgress: value => progress.push(value) });
    while (started.length === 0) await tick();
    task.pause();
    await tick();
    const countAtPause = started.length;
    expect(aborted).toBeGreaterThan(0);
    expect(started.length).toBe(countAtPause);
    expect(progress.at(-1)).toMatchObject({ phase: 'paused', loadedBytes: 3, uploadedChunks: 1 });
    expect(progress.at(-1)).not.toHaveProperty('speedBytesPerSecond');
    expect(progress.at(-1)).not.toHaveProperty('etaSeconds');
    expect(progress.some(value => value.phase === 'failed')).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    task.resume();
    await task.promise;
    expect(get).toHaveBeenCalledWith(`/api/uploads/${id}`);
    expect(started.slice(countAtPause).sort()).toEqual([1, 2, 3]);
    expect(progress.find(value => value.phase === 'uploading' && value.uploadedChunks >= 1)?.loadedBytes).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)?.phase).toBe('complete');
  });

  it('keeps Cancel permanent and calls backend cleanup', async () => {
    const file = new File([Buffer.from('abcdef')], 'cancel.txt');
    vi.spyOn(api, 'post').mockResolvedValue({ data: { upload: session(file) } });
    vi.spyOn(api, 'put').mockImplementation((_url, _body, config) => new Promise((_resolve, reject) => { config?.signal?.addEventListener?.('abort', () => reject(new DOMException('cancel', 'AbortError')), { once: true }); }));
    const remove = vi.spyOn(api, 'delete').mockResolvedValue({ data: undefined, status: 204 });
    const progress: ChunkedUploadProgress[] = [];
    const task = startChunkedUpload({ file, folderId: null, onProgress: value => progress.push(value) });
    const result = task.promise.catch(error => { throw error; });
    while (!progress.some(value => value.phase === 'uploading')) await tick();
    await task.cancel();
    task.resume();
    await expect(result).rejects.toSatisfy(error => axios.isCancel(error) || (error as Error).name === 'AbortError');
    expect(remove).toHaveBeenCalledWith(`/api/uploads/${id}`);
    expect(progress.at(-1)).toMatchObject({ phase: 'cancelled', loadedBytes: 0, uploadedChunks: 0 });
    expect(uploadActionsForPhase('cancelled')).not.toContain('resume');
  });
});

describe('chunk retry and transfer metrics', () => {
  it('retries network/5xx failures after 500, 1000 and 2000ms', async () => {
    vi.useFakeTimers();
    const file = new File([Buffer.from('abc')], 'retry.txt');
    vi.spyOn(api, 'post').mockImplementation(async url => url === '/api/uploads' ? { data: { upload: session(file) } } as never : { data: { file: { id: 'file' } } } as never);
    const attempts: number[] = [];
    const errors = [new axios.AxiosError('Network Error', 'ERR_NETWORK'), new axios.AxiosError('Server', 'ERR_BAD_RESPONSE', undefined, undefined, { status: 503 } as never), new axios.AxiosError('Network Error', 'ERR_NETWORK')];
    const put = vi.spyOn(api, 'put').mockImplementation(async () => { attempts.push(Date.now()); const error = errors.shift(); if (error) throw error; return { data: {} }; });
    const task = startChunkedUpload({ file, folderId: null, onProgress: () => undefined });
    await vi.runAllTimersAsync();
    await task.promise;
    expect(put).toHaveBeenCalledTimes(4);
    expect(attempts.map(at => at - attempts[0]!)).toEqual([0, 500, 1_500, 3_500]);
  });

  it('does not retry 4xx business errors', async () => {
    const file = new File([Buffer.from('abc')], 'bad.txt');
    vi.spyOn(api, 'post').mockResolvedValue({ data: { upload: session(file) } });
    const put = vi.spyOn(api, 'put').mockRejectedValue(new axios.AxiosError('Bad request', 'ERR_BAD_REQUEST', undefined, undefined, { status: 422 } as never));
    const task = startChunkedUpload({ file, folderId: null, onProgress: () => undefined });
    await expect(task.promise).rejects.toBeTruthy();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('uses a recent sliding window for speed and ETA and emits no infinite ETA at zero speed', () => {
    expect(calculateTransferMetrics([{ at: 0, bytes: 100 }, { at: 5_000, bytes: 200 }], 1_000, 5_000)).toEqual({ speedBytesPerSecond: 20, etaSeconds: 40 });
    expect(calculateTransferMetrics([{ at: 0, bytes: 100 }, { at: 5_000, bytes: 100 }], 1_000, 5_000)).toEqual({});
    expect(calculateTransferMetrics([{ at: 0, bytes: 0 }, { at: 11_000, bytes: 10 }, { at: 12_000, bytes: 30 }], 100, 12_000)).toEqual({ speedBytesPerSecond: 20, etaSeconds: 3.5 });
  });
});

describe('upload size preflight', () => {
  it('allows 1 GB and exactly 5 GB through frontend preflight', () => { expect(() => validateUploadFileSize(1024 * 1024 * 1024)).not.toThrow(); expect(() => validateUploadFileSize(MAX_UPLOAD_FILE_SIZE)).not.toThrow(); });
  it('rejects a file above 5 GB before creating an upload session', async () => {
    const post = vi.spyOn(api, 'post'); const size = MAX_UPLOAD_FILE_SIZE + 1; const file = { name: 'too-large.bin', type: 'application/octet-stream', size } as File; const progress: ChunkedUploadProgress[] = [];
    const task = startChunkedUpload({ file, folderId: null, onProgress: value => progress.push(value) });
    await expect(task.promise).rejects.toSatisfy(error => parseApiError(error, 'Upload failed') === 'File exceeds the maximum allowed size.\nMaximum allowed size: 5 GB.');
    expect(post).not.toHaveBeenCalled(); expect(progress.at(-1)).toEqual({ phase: 'failed', loadedBytes: 0, totalBytes: size, uploadedChunks: 0, totalChunks: Math.ceil(size / CHUNK_SIZE_BYTES) });
  });
});
