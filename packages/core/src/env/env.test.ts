import { describe, expect, it } from 'vitest';
import { hashContent } from '../data-dir/hash.js';
import { createMutationPlan } from '../plans/plan.js';
import { sanitizeAuditPayload } from '../redaction/sanitize.js';
import { envFileSchema } from '../schema/env.js';
import { Secret } from '../tags/secret.js';
import type { ResolutionContext } from '../tags/types.js';
import {
  assertEnvRenderTarget,
  ENV_FILE_MODE,
  EnvRenderError,
  isEnvFileOutdated,
  quoteEnvValue,
  renderEnvFile,
} from './render.js';

function context(
  overrides: Partial<ResolutionContext> = {},
): ResolutionContext {
  return { dataDir: '/fixture', ...overrides };
}

const secretProvider = {
  resolveSecret(key: string) {
    if (key === 'db')
      return { status: 'found' as const, value: 's3cr3t-value' };
    if (key === 'locked') {
      return { status: 'locked' as const, reason: 'vault is locked' };
    }
    return { status: 'not_found' as const };
  },
};

/** Decode the double-quoted form with Compose's literal-dollar rule. */
function decodeQuoted(value: string): string {
  expect(value.startsWith('"')).toBe(true);
  expect(value.endsWith('"')).toBe(true);
  return (JSON.parse(value) as string).replaceAll('$$', '$');
}

describe('env file schema', () => {
  it('accepts tagged and literal strings and rejects unsafe shapes', () => {
    expect(
      envFileSchema.safeParse({
        schema_version: 1,
        values: {
          APP_PORT: '8080',
          DB_PASSWORD: { tag: 'secret', value: 'db' },
        },
      }).success,
    ).toBe(true);
    expect(
      envFileSchema.safeParse({ schema_version: 1, values: {} }).success,
    ).toBe(true);
    expect(
      envFileSchema.safeParse({ schema_version: 1, values: { APP_PORT: 8080 } })
        .success,
    ).toBe(false);
    expect(
      envFileSchema.safeParse({
        schema_version: 1,
        values: { 'bad-name': 'x' },
      }).success,
    ).toBe(false);
    expect(
      envFileSchema.safeParse({
        schema_version: 1,
        values: { APP: 'x' },
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('dotenv quoting', () => {
  it('round-trips quotes, dollars, hashes, spaces and newlines', () => {
    const values = [
      '',
      'simple',
      "it's",
      'say "hi"',
      'back\\slash',
      'back\\slash and "quote"',
      "back\\'quote",
      'price $5 and ${VAR} and $$',
      '# not a comment',
      '  leading and trailing  ',
      'line1\nline2',
      'tab\there',
      'carriage\rreturn',
      'back\\nslash n',
      'back\\tnot a tab',
      'unicode ✓',
    ];
    for (const value of values) {
      const quoted = quoteEnvValue(value);
      expect(decodeQuoted(quoted)).toBe(value);
      expect(quoted).not.toContain('\n');
      expect(quoted).not.toContain('\r');
    }
    expect(quoteEnvValue('')).toBe('""');
    expect(quoteEnvValue('\u0007')).toBe('"\\a"');
    expect(quoteEnvValue('\b\f\v')).toBe('"\\b\\f\\v"');
  });

  it('rejects control characters that dotenv cannot represent', () => {
    expect(() => quoteEnvValue('\u0000')).toThrow(EnvRenderError);
    expect(() => quoteEnvValue('\u001b')).toThrow(EnvRenderError);
  });

  it('only allows a destination named .env', () => {
    expect(assertEnvRenderTarget('.env')).toBe('.env');
    expect(assertEnvRenderTarget('/opt/app/.env')).toBe('/opt/app/.env');
    expect(assertEnvRenderTarget('C:\\app\\.env')).toBe('C:\\app\\.env');
    expect(() => assertEnvRenderTarget('/opt/app/.env.yaml')).toThrow(
      EnvRenderError,
    );
    expect(() => assertEnvRenderTarget('/opt/app/env')).toThrow(EnvRenderError);
    expect(() => assertEnvRenderTarget('/opt/app/.env.local')).toThrow(
      EnvRenderError,
    );
  });
});

describe('renderEnvFile', () => {
  it('resolves tags, sorts keys, hashes the output and masks the content', async () => {
    const input = {
      schema_version: 1,
      values: {
        ZED: 'last',
        ALPHA: 'first',
        QUOTED: 'a "quote" and $dollar',
        SECRET: { tag: 'secret', value: 'db' },
        FROM_ENV: { tag: 'env', value: 'HACM_ENV_TEST' },
        NUMBER: { tag: 'expr', value: '1 + 2' },
        FLAG: { tag: 'expr', value: 'true' },
      },
    };
    const rendered = await renderEnvFile(
      input,
      context({
        env: { HACM_ENV_TEST: 'from-env' },
        secretProvider,
      }),
    );

    expect(rendered.variables).toEqual([
      'ALPHA',
      'FLAG',
      'FROM_ENV',
      'NUMBER',
      'QUOTED',
      'SECRET',
      'ZED',
    ]);
    expect(rendered.mode).toBe(ENV_FILE_MODE);
    expect(rendered.mode).toBe('0600');
    const content = rendered.content.unwrap();
    expect(content).toBe(
      [
        'ALPHA="first"',
        'FLAG="true"',
        'FROM_ENV="from-env"',
        'NUMBER="3"',
        'QUOTED="a \\"quote\\" and $$dollar"',
        'SECRET="s3cr3t-value"',
        'ZED="last"',
        '',
      ].join('\n'),
    );
    expect(rendered.hash).toBe(await hashContent(content));
    expect(rendered.size).toBe(new TextEncoder().encode(content).byteLength);

    expect(rendered.content).toBeInstanceOf(Secret);
    expect(JSON.stringify(rendered.content)).toBe('"***"');
    expect(String(rendered.content)).toBe('***');
    expect(JSON.stringify(rendered)).not.toContain('s3cr3t-value');
    expect(JSON.stringify(rendered)).toContain(rendered.hash);
    expect(sanitizeAuditPayload(rendered)).toMatchObject({
      content: '***',
      hash: rendered.hash,
      mode: '0600',
      variables: rendered.variables,
      size: rendered.size,
    });

    const again = await renderEnvFile(
      input,
      context({
        env: { HACM_ENV_TEST: 'from-env' },
        secretProvider,
      }),
    );
    expect(again.hash).toBe(rendered.hash);
    expect(again.content.unwrap()).toBe(content);
  });

  it('renders an empty file when there are no values', async () => {
    const rendered = await renderEnvFile(
      { schema_version: 1, values: {} },
      context(),
    );
    expect(rendered.variables).toEqual([]);
    expect(rendered.content.unwrap()).toBe('');
    expect(rendered.size).toBe(0);
    expect(rendered.hash).toBe(await hashContent(''));
  });

  it('rejects invalid documents and non-scalar tag results', async () => {
    await expect(renderEnvFile('not a mapping', context())).rejects.toThrow(
      'Invalid .env.yaml',
    );
    await expect(
      renderEnvFile(
        { schema_version: 1, values: { APP_PORT: 8080 } },
        context(),
      ),
    ).rejects.toThrow('values.APP_PORT');
    await expect(
      renderEnvFile(
        {
          schema_version: 1,
          values: { BAD: { tag: 'expr', value: 'null' } },
        },
        context(),
      ),
    ).rejects.toThrow("Variable 'BAD' did not resolve to a scalar value");
  });

  it('reports unresolved, locked and errored tags without values', async () => {
    await expect(
      renderEnvFile(
        {
          schema_version: 1,
          values: { MISSING: { tag: 'env', value: 'HACM_NOT_SET' } },
        },
        context({ env: {} }),
      ),
    ).rejects.toThrow("!env HACM_NOT_SET: Environment variable 'HACM_NOT_SET'");

    await expect(
      renderEnvFile(
        {
          schema_version: 1,
          values: { LOCKED: { tag: 'secret', value: 'locked' } },
        },
        context({ secretProvider }),
      ),
    ).rejects.toThrow('!secret locked: vault is locked');

    await expect(
      renderEnvFile(
        {
          schema_version: 1,
          values: { BROKEN: { tag: 'expr', value: '1 +' } },
        },
        context(),
      ),
    ).rejects.toThrow('!expr 1 +:');
  });

  it('keeps rendered content out of plans', async () => {
    const rendered = await renderEnvFile(
      {
        schema_version: 1,
        values: { DB_PASSWORD: { tag: 'secret', value: 'db' } },
      },
      context({ secretProvider }),
    );
    const plan = createMutationPlan({
      id: 'plan-env',
      operation: 'render-env',
      target: { hostId: 'example-host', vmid: 112, resourceType: 'guest' },
      summary: `Render .env (sha256 ${rendered.hash.slice(0, 12)}…)`,
      changes: [
        {
          id: 'env',
          action: 'create',
          path: '/opt/app/.env',
          summary: 'Render .env from .env.yaml',
          after: {
            hash: rendered.hash,
            mode: rendered.mode,
            size: rendered.size,
            variables: rendered.variables,
          },
        },
      ],
      currentState: { hash: null },
    });
    expect(JSON.stringify(plan)).not.toContain('s3cr3t-value');
    expect(JSON.stringify(plan)).toContain(rendered.hash);
  });
});

describe('isEnvFileOutdated', () => {
  const rendered = {
    content: new Secret('A="1"\n'),
    hash: 'a'.repeat(64),
    mode: ENV_FILE_MODE,
    variables: ['A'],
    size: 6,
  };

  it('compares hashes and the 0600 mode without plaintext', () => {
    expect(
      isEnvFileOutdated(rendered, { hash: rendered.hash, mode: '0600' }),
    ).toBe(false);
    expect(
      isEnvFileOutdated(rendered, { hash: rendered.hash, mode: '600' }),
    ).toBe(false);
    expect(
      isEnvFileOutdated(rendered, { hash: 'b'.repeat(64), mode: '0600' }),
    ).toBe(true);
    expect(
      isEnvFileOutdated(rendered, { hash: rendered.hash, mode: '0644' }),
    ).toBe(true);
    expect(isEnvFileOutdated(rendered, { hash: rendered.hash })).toBe(true);
    expect(isEnvFileOutdated(rendered, null)).toBe(true);
    expect(isEnvFileOutdated(rendered)).toBe(true);
  });
});
