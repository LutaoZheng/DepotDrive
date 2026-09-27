const colors: Record<string,string> = {
  HEALTHY:'bg-emerald-50 text-emerald-700 ring-emerald-600/20', AVAILABLE:'bg-emerald-50 text-emerald-700 ring-emerald-600/20', SUCCESS:'bg-emerald-50 text-emerald-700 ring-emerald-600/20', complete:'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  CORRUPT:'bg-rose-50 text-rose-700 ring-rose-600/20', MISSING:'bg-rose-50 text-rose-700 ring-rose-600/20', FAILURE:'bg-rose-50 text-rose-700 ring-rose-600/20', failed:'bg-rose-50 text-rose-700 ring-rose-600/20', DISCONNECTED:'bg-rose-50 text-rose-700 ring-rose-600/20',
  UNAVAILABLE:'bg-amber-50 text-amber-700 ring-amber-600/20', STALE:'bg-amber-50 text-amber-700 ring-amber-600/20', paused:'bg-amber-50 text-amber-700 ring-amber-600/20',
  RUNNING:'bg-blue-50 text-blue-700 ring-blue-600/20', uploading:'bg-blue-50 text-blue-700 ring-blue-600/20', hashing:'bg-violet-50 text-violet-700 ring-violet-600/20', completing:'bg-violet-50 text-violet-700 ring-violet-600/20', INFO:'bg-slate-100 text-slate-700 ring-slate-600/20',
};
export function StatusBadge({status}:{status:string}){return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${colors[status]??'bg-slate-100 text-slate-700 ring-slate-600/20'}`}><span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current"/>{status.replaceAll('_',' ')}</span>}
