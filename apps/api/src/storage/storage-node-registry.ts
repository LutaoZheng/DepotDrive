import type { StorageNode } from './storage-node.js';

export class StorageNodeRegistry {
  private readonly nodes: Map<string, StorageNode>;
  constructor(nodes: StorageNode[]) {
    if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error('Duplicate storage node id');
    this.nodes = new Map(nodes.map(node => [node.id, node]));
  }
  all() { return Array.from(this.nodes.values()); }
  get(id: string) { return this.nodes.get(id); }
  require(id: string) { const node = this.get(id); if (!node) throw new Error(`Storage node ${id} is not registered`); return node; }
}
