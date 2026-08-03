export interface PlacementCandidate { id: string; usedBytes: bigint; capacityBytes: bigint; primaryCount: number }

/** Deterministic least-utilized placement. No hashing or rebalancing is intentionally introduced in V0.3.1. */
export function chooseReplicaNodes(candidates: PlacementCandidate[], count = 2): PlacementCandidate[] {
  return [...candidates]
    .filter(node => node.capacityBytes > node.usedBytes)
    .sort((a, b) => {
      const left = a.usedBytes * b.capacityBytes;
      const right = b.usedBytes * a.capacityBytes;
      return left === right ? a.primaryCount - b.primaryCount || a.id.localeCompare(b.id) : left < right ? -1 : 1;
    })
    .slice(0, count);
}
