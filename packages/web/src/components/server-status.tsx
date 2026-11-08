import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/client';

export function ServerStatus() {
  const { data, isError, isPending } = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const { data: body, error } = await apiClient.GET('/api/health');
      if (error || !body) throw new Error('Health check failed');
      return body;
    },
    refetchInterval: 30_000,
    retry: false,
  });
  const state = isPending
    ? 'checking'
    : isError || !data
      ? 'offline'
      : 'online';
  const color =
    state === 'online'
      ? 'bg-green-500'
      : state === 'offline'
        ? 'bg-red-500'
        : 'bg-yellow-500';
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className={`h-2 w-2 rounded-full ${color}`} />
      <span>API {state}</span>
    </span>
  );
}
