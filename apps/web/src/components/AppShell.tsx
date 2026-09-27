import type { PropsWithChildren, ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../auth';

const navClass = ({ isActive }: { isActive: boolean }) => `nav-link ${isActive ? 'nav-link-active' : ''}`;

export function AppShell({ title, description, actions, children }: PropsWithChildren<{ title: string; description?: string; actions?: ReactNode }>) {
  const auth = useAuth();
  return <div className="min-h-screen bg-slate-50">
    <header className="relative z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link to="/drive" className="flex items-center gap-3 font-bold tracking-tight"><span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-950 text-white shadow-sm">D</span><span>DepotDrive</span></Link>
        <nav aria-label="Primary" className="hidden items-center gap-1 md:flex"><NavLink className={navClass} to="/drive">My Drive</NavLink>{auth.user?.role==='ADMIN'&&<><NavLink className={navClass} to="/monitor">System Monitor</NavLink><NavLink className={navClass} to="/reliability">Reliability Demo</NavLink></>}</nav>
        <div className="flex items-center gap-3"><span className="hidden max-w-48 truncate text-sm text-slate-500 sm:block">{auth.user?.email}</span><button className="btn-secondary" onClick={()=>void auth.logout()}>Sign out</button></div>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-t px-4 py-2 md:hidden"><NavLink className={navClass} to="/drive">My Drive</NavLink>{auth.user?.role==='ADMIN'&&<><NavLink className={navClass} to="/monitor">Monitor</NavLink><NavLink className={navClass} to="/reliability">Demo</NavLink></>}</nav>
    </header>
    <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{title}</h1>{description&&<p className="mt-1.5 max-w-2xl text-sm text-slate-500">{description}</p>}</div>{actions&&<div className="flex flex-wrap gap-2">{actions}</div>}</div>
      {children}
    </main>
  </div>;
}
