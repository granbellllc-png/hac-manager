import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWhoami } from './whoami.js';

let stdout = '';
let stderr = '';

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => vi.restoreAllMocks());

describe('runWhoami', () => {
  it('authenticates with a token sourced from an environment variable', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        setupNeeded: false,
        user: { id: 'user-1', username: 'fixture', role: 'operator' },
      }),
    );
    expect(
      await runWhoami({
        server: 'https://hacm.example.test/base',
        env: { HACM_API_TOKEN: 'fake-api-token' },
        fetchFn,
      }),
    ).toBe(0);
    expect(stdout).toContain('Authenticated as fixture (operator)');
    expect(fetchFn).toHaveBeenCalledWith(
      new URL('https://hacm.example.test/api/auth/status'),
      { headers: { authorization: 'Bearer fake-api-token' } },
    );
    expect(`${stdout}${stderr}`).not.toContain('fake-api-token');
  });

  it('supports custom token variables and JSON output', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        user: { id: 'user-1', username: 'fixture', role: 'viewer' },
      }),
    );
    expect(
      await runWhoami({
        server: 'https://hacm.example.test',
        tokenEnv: 'CUSTOM_TOKEN',
        env: { CUSTOM_TOKEN: 'fake-custom-token' },
        json: true,
        fetchFn,
      }),
    ).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      id: 'user-1',
      username: 'fixture',
      role: 'viewer',
    });
  });

  it('reports missing options, invalid responses, HTTP failures, and network errors safely', async () => {
    expect(await runWhoami({ env: {} })).toBe(1);
    expect(stderr).toContain('Missing server URL');
    stderr = '';
    expect(
      await runWhoami({ server: 'https://hacm.example.test', env: {} }),
    ).toBe(1);
    expect(stderr).toContain('Missing API token');
    stderr = '';
    expect(
      await runWhoami({
        server: 'not a url',
        env: { HACM_API_TOKEN: 'fake-sensitive-token' },
      }),
    ).toBe(1);
    expect(stderr).toContain('Invalid HAC Manager server URL');
    stderr = '';
    expect(
      await runWhoami({
        server: 'https://hacm.example.test',
        env: { HACM_API_TOKEN: 'fake-sensitive-token' },
        fetchFn: vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({}, { status: 401 })),
      }),
    ).toBe(1);
    expect(stderr).toContain('HTTP 401');
    stderr = '';
    expect(
      await runWhoami({
        server: 'https://hacm.example.test',
        env: { HACM_API_TOKEN: 'fake-sensitive-token' },
        fetchFn: vi.fn<typeof fetch>().mockResolvedValue(Response.json({})),
      }),
    ).toBe(1);
    expect(stderr).toContain('not accepted');
    stderr = '';
    expect(
      await runWhoami({
        server: 'https://hacm.example.test',
        env: { HACM_API_TOKEN: 'fake-sensitive-token' },
        fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')),
      }),
    ).toBe(1);
    expect(stderr).toContain('offline');
    expect(`${stdout}${stderr}`).not.toContain('fake-sensitive-token');
  });
});
