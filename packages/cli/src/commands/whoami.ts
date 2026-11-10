export interface CliWhoamiOptions {
  readonly server?: string | undefined;
  readonly tokenEnv?: string | undefined;
  readonly json?: boolean | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

export async function runWhoami(
  options: CliWhoamiOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const server = options.server ?? env['HACM_SERVER_URL'];
  const tokenEnv = options.tokenEnv ?? 'HACM_API_TOKEN';
  const token = env[tokenEnv];
  if (!server) {
    process.stderr.write(
      'Missing server URL. Set HACM_SERVER_URL or pass --server.\n',
    );
    return 1;
  }
  if (!token) {
    process.stderr.write(
      `Missing API token. Set ${tokenEnv} or choose another variable with --token-env.\n`,
    );
    return 1;
  }
  let url: URL;
  try {
    url = new URL('/api/auth/status', server);
  } catch {
    process.stderr.write('Invalid HAC Manager server URL.\n');
    return 1;
  }
  try {
    const response = await (options.fetchFn ?? fetch)(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      process.stderr.write(
        `API authentication failed with HTTP ${response.status}.\n`,
      );
      return 1;
    }
    const payload = (await response.json()) as {
      user?: { id?: unknown; username?: unknown; role?: unknown } | null;
    };
    if (
      !payload.user ||
      typeof payload.user.id !== 'string' ||
      typeof payload.user.username !== 'string' ||
      typeof payload.user.role !== 'string'
    ) {
      process.stderr.write('API token was not accepted by the server.\n');
      return 1;
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload.user)}\n`);
    } else {
      process.stdout.write(
        `Authenticated as ${payload.user.username} (${payload.user.role})\n`,
      );
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `Failed to contact HAC Manager: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
