import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, createApiClient } from './client';

describe('api client', () => {
  afterEach(() => {
    document.cookie = 'hacm_csrf=; Max-Age=0; path=/';
    vi.unstubAllGlobals();
  });
  it('exposes a default client and a factory', () => {
    expect(typeof apiClient.GET).toBe('function');
    expect(typeof createApiClient('http://x').GET).toBe('function');
  });

  it('attaches the decoded CSRF cookie only to mutating requests', async () => {
    document.cookie = 'hacm_csrf=fixture%20token; path=/';
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ message: 'ok' }));
    vi.stubGlobal('fetch', fetchFn);
    await apiClient.POST('/api/auth/logout');
    expect(
      (fetchFn.mock.calls[0]?.[0] as Request).headers.get('x-csrf-token'),
    ).toBe('fixture token');
    await apiClient.GET('/api/auth/status');
    expect(
      (fetchFn.mock.calls[1]?.[0] as Request).headers.has('x-csrf-token'),
    ).toBe(false);
    document.cookie = 'hacm_csrf=; path=/';
    await apiClient.POST('/api/auth/logout');
    expect(
      (fetchFn.mock.calls[2]?.[0] as Request).headers.has('x-csrf-token'),
    ).toBe(false);
  });

  it('handles a request when no document is available', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ message: 'ok' }));
    vi.stubGlobal('fetch', fetchFn);
    vi.stubGlobal('document', undefined);
    try {
      await apiClient.POST('/api/auth/logout');
      expect(
        (fetchFn.mock.calls[0]?.[0] as Request).headers.has('x-csrf-token'),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
