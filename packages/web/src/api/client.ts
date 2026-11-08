import createClient from 'openapi-fetch';
import type { paths } from './schema';

export function createApiClient(baseUrl = window.location.origin) {
  return createClient<paths>({
    baseUrl,
    fetch: (request) => globalThis.fetch(request),
  });
}

export const apiClient = createApiClient();
