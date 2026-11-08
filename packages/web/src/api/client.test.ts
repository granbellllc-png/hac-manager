import { describe, expect, it } from 'vitest';
import { apiClient, createApiClient } from './client';

describe('api client', () => {
  it('exposes a default client and a factory', () => {
    expect(typeof apiClient.GET).toBe('function');
    expect(typeof createApiClient('http://x').GET).toBe('function');
  });
});
