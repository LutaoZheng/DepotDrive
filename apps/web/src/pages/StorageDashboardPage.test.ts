import { describe, expect, it } from 'vitest';
import { storagePercent } from './StorageDashboardPage';

describe('storage dashboard', () => {
  it('calculates bounded storage utilization', () => {
    expect(storagePercent(18, 100)).toBe(18);
    expect(storagePercent(120, 100)).toBe(100);
    expect(storagePercent(1, 0)).toBe(0);
  });
});
