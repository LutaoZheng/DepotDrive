import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { StorageNodesResponse } from '@depot-drive/shared';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { protectedQueryEnabled } from '../auth-policy';

const size = (bytes: number) => bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
export const storagePercent = (used: number, capacity: number) => capacity > 0 ? Math.min(100, Math.round(used / capacity * 100)) : 0;

export function StorageDashboardPage() {
  const auth = useAuth();
  const nodes = useQuery({ queryKey: ['storage', 'nodes'], queryFn: async () => (await api.get<StorageNodesResponse>('/api/storage/nodes')).data.nodes, enabled: protectedQueryEnabled(auth.user), refetchInterval: 5_000, retry: false });
  return <div className="min-h-screen bg-slate-50"><header className="flex h-16 items-center justify-between border-b bg-white px-5 lg:px-8"><Link to="/drive" className="font-bold">DepotDrive</Link><div className="flex gap-2"><Link className="btn-secondary" to="/drive">My Drive</Link><button className="btn-secondary" onClick={() => void auth.logout()}>Logout</button></div></header><main className="mx-auto max-w-6xl p-5 lg:p-8"><div className="mb-6 flex items-end justify-between"><div><h1 className="text-2xl font-bold">Storage Dashboard</h1><p className="mt-1 text-sm text-slate-500">Node heartbeat, capacity, and replica placement.</p></div><button className="btn-secondary" onClick={() => void nodes.refetch()}>Refresh</button></div>{nodes.isLoading ? <div className="card p-10 text-center">Loading storage nodes…</div> : nodes.isError ? <div className="card p-10 text-center text-red-600">{errorMessage(nodes.error)}</div> : <div className="grid gap-4 md:grid-cols-3">{nodes.data?.map(node => { const percent = storagePercent(node.usedBytes, node.capacityBytes); return <section className="card p-5" key={node.id}><div className="flex items-center justify-between"><h2 className="font-bold">{node.name}</h2><span className={node.alive ? 'text-emerald-600' : 'text-red-600'}>{node.alive ? '● Alive' : '● Dead'}</span></div><div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-brand-500" style={{ width: `${percent}%` }}/></div><p className="mt-2 text-sm">Used: {percent}% · {size(node.usedBytes)} / {size(node.capacityBytes)}</p><dl className="mt-5 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-slate-500">Primary</dt><dd className="font-semibold">{node.primaryCount}</dd></div><div><dt className="text-slate-500">Replicas</dt><dd className="font-semibold">{node.replicaCount}</dd></div></dl><p className="mt-4 text-xs text-slate-500">Last heartbeat: {node.lastHeartbeat ? new Date(node.lastHeartbeat).toLocaleString() : 'Never'}</p></section> })}</div>}</main></div>;
}
