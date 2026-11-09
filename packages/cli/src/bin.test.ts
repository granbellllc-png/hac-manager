import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('./cli.js');
});

describe('CLI executable exit contract', () => {
  it.each([0, 2])('propagates command exit code %s', async (code) => {
    vi.resetModules();
    const run = vi.fn().mockResolvedValue(code);
    vi.doMock('./cli.js', () => ({ runCli: run }));
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    await import('./bin.js');
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith(process.argv.slice(2)),
    );
    if (code === 0) expect(exit).not.toHaveBeenCalled();
    else await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(code));
  });

  it.each([new Error('fixture rejection'), 'fixture non-Error rejection'])(
    'reports an unhandled command failure',
    async (error) => {
      vi.resetModules();
      vi.doMock('./cli.js', () => ({
        runCli: vi.fn().mockRejectedValue(error),
      }));
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      await import('./bin.js');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('fixture'));
    },
  );
});
