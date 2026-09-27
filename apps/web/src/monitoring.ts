import { useQuery } from '@tanstack/react-query';
import type { MonitorOverviewDto } from '@depot-drive/shared';
import { api } from './api';
export function useMonitor(enabled=true){return useQuery({queryKey:['monitoring','overview'],queryFn:async()=>(await api.get<MonitorOverviewDto>('/api/monitoring/overview')).data,enabled,refetchInterval:3_000,retry:false,staleTime:0})}
