import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectStore } from '../src/object-store.js';

let root: string;
let store: ObjectStore;
const key = '00000000-0000-4000-8000-000000000001';
const checksum = (value: Buffer) => createHash('sha256').update(value).digest('hex');

describe('ObjectStore', () => {
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'depot-node-')); store = new ObjectStore(root, 1024); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it('persists an object and reports verified metadata', async () => {
    const data = Buffer.from('independent replica');
    await expect(store.put(key, Readable.from(data), { sizeBytes: data.length, sha256: checksum(data) })).resolves.toEqual({ sizeBytes: data.length, sha256: checksum(data) });
    await expect(store.metadata(key)).resolves.toEqual({ sizeBytes: data.length, sha256: checksum(data) });
  });
  it('makes identical puts idempotent and rejects conflicting content', async () => {
    const data = Buffer.from('same');
    const expected = { sizeBytes: data.length, sha256: checksum(data) };
    await store.put(key, Readable.from(data), expected);
    await expect(store.put(key, Readable.from(data), expected)).resolves.toEqual(expected);
    const other = Buffer.from('else');
    await expect(store.put(key, Readable.from(other), { sizeBytes: other.length, sha256: checksum(other) })).rejects.toThrow('OBJECT_CONFLICT');
  });
  it('persists checksum metadata across restart while byte verification still detects corruption', async () => {
    const data = Buffer.from('durable checksum');
    const expected = { sizeBytes: data.length, sha256: checksum(data) };
    await store.put(key, Readable.from(data), expected);
    store = new ObjectStore(root, 1024);
    await expect(store.metadata(key)).resolves.toEqual(expected);
    await store.corrupt(key);
    await expect(store.metadata(key)).resolves.toEqual(expected);
    const actual = await store.verify(key);
    expect(actual?.sizeBytes).toBe(expected.sizeBytes);
    expect(actual?.sha256).not.toBe(expected.sha256);
  });
  it('atomically replaces a damaged object only when repair explicitly allows it', async () => {
    const original = Buffer.from('original bytes');
    const repaired = Buffer.from('repaired bytes');
    await store.put(key, Readable.from(original), { sizeBytes: original.length, sha256: checksum(original) });
    await expect(store.put(key, Readable.from(repaired), { sizeBytes: repaired.length, sha256: checksum(repaired) }, true)).resolves.toEqual({ sizeBytes: repaired.length, sha256: checksum(repaired) });
    await expect(store.verify(key)).resolves.toEqual({ sizeBytes: repaired.length, sha256: checksum(repaired) });
  });
});
