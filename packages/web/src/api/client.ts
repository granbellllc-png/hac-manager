import createClient from 'openapi-fetch';
import type { paths } from './schema';

function getCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  const val = match?.[1];
  return val ? decodeURIComponent(val) : undefined;
}

export function createApiClient(baseUrl = window.location.origin) {
  return createClient<paths>({
    baseUrl,
    fetch: (request) => {
      const csrf = getCookie('hacm_csrf');
      if (
        csrf &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
          request.method.toUpperCase(),
        )
      ) {
        request.headers.set('x-csrf-token', csrf);
      }
      return globalThis.fetch(request);
    },
  });
}

export const apiClient = createApiClient();
