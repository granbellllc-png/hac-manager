import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadYamlDocument, yamlDocumentToJS } from '../index.js';
import { describe, expect, it } from 'vitest';
import {
  allEditorJsonSchemas,
  configKinds,
  configSchemas,
  formatIssues,
  guestDeploymentSchema,
  isTagValue,
  migrateDocument,
  parseConfig,
  renderConfigReference,
  schemaToRows,
  toEditorJsonSchema,
  type ConfigKind,
  type Migration,
} from '../index.js';

function loadYaml(text: string): unknown {
  return yamlDocumentToJS(loadYamlDocument(text));
}

const root = resolve(import.meta.dirname, '../../../..');
const exampleData = join(root, 'examples/data');
const invalidDir = resolve(import.meta.dirname, '../../fixtures/invalid');

function readYaml(path: string): unknown {
  return loadYaml(readFileSync(path, 'utf8'));
}

function issuesOf(name: string, kind: ConfigKind) {
  const result = parseConfig(kind, readYaml(join(invalidDir, name)));
  if (result.ok) throw new Error(`${name} unexpectedly valid`);
  return result.issues;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function kindOf(relative: string): ConfigKind | undefined {
  const parts = relative.split('/');
  const file = parts.at(-1) ?? '';
  if (file === 'host.yaml') return 'host';
  if (file === 'default-deployment.yaml') return 'deployment-defaults';
  if (file === 'deployment.yaml') return 'deployment';
  if (file === 'default-filemappings.yaml' || file === 'filemappings.yaml')
    return 'filemappings';
  if (file === '.env.yaml') return 'env';
  if (file === 'secrets.yaml.example') return 'secrets';
  if (parts.includes('tasks') || parts.includes('global-tasks')) {
    return file.endsWith('.yaml') ? 'tasks' : undefined;
  }
  return undefined;
}

describe('examples/data', () => {
  const files = [...walk(exampleData)]
    .map((path) => path.slice(exampleData.length + 1).replaceAll('\\', '/'))
    .flatMap((relative) => {
      const kind = kindOf(relative);
      return kind ? [{ relative, kind }] : [];
    });

  it('covers every config kind', () => {
    expect(new Set(files.map((f) => f.kind))).toEqual(new Set(configKinds));
  });

  it.each(files)('$relative is a valid $kind file', ({ relative, kind }) => {
    const result = parseConfig(kind, readYaml(join(exampleData, relative)));
    expect(result).toMatchObject({ ok: true });
  });

  it('parses tags into tag values', () => {
    const result = parseConfig(
      'host',
      readYaml(join(exampleData, 'hosts/example-host/host.yaml')),
    );
    if (!result.ok) throw new Error('invalid');
    expect(isTagValue(result.value.connection.ssh.private_key)).toBe(true);
    expect(result.value.connection.ssh.port).toBe(22);
  });
});

describe('invalid fixtures report precise paths', () => {
  it('flags bad scalar values with dotted paths', () => {
    const paths = issuesOf('guest-bad-values.yaml', 'deployment').map(
      (i) => i.path,
    );
    expect(paths).toContain('cpu');
    expect(paths).toContain('disks.0.size_gb');
    expect(paths).toContain('network.0.ip');
    expect(paths).not.toContain('network.0.mac');
  });

  it('rejects keys of the other guest type', () => {
    const issues = issuesOf('vm-unknown-key.yaml', 'deployment');
    expect(issues).toContainEqual(
      expect.objectContaining({ path: '', code: 'unrecognized_keys' }),
    );
    expect(issues[0]?.message).toContain('unprivileged');
  });

  it('validates host fields', () => {
    const paths = issuesOf('host-bad.yaml', 'host').map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'id',
        'index',
        'connection.ssh.port',
        'connection.ssh.host',
      ]),
    );
  });

  it('requires a schema_version', () => {
    expect(issuesOf('missing-version.yaml', 'host')).toEqual([
      expect.objectContaining({
        path: 'schema_version',
        code: 'missing_version',
      }),
    ]);
  });

  it('validates file mappings', () => {
    const paths = issuesOf('filemappings-bad.yaml', 'filemappings').map(
      (i) => i.path,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        'mappings.0.source',
        'mappings.0.destination',
        'mappings.0.mode',
        'mappings.0.conflict',
        'mappings.1.source',
      ]),
    );
  });
});

describe('schema behaviour', () => {
  const guest = {
    id: 112,
    name: 'g',
    type: 'lxc',
    cpu: 1,
    ram: 512,
    disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 8 }],
    network: [{ index: 0 }],
  };

  it('requires cpu, ram, disks and network on a merged guest', () => {
    expect(guestDeploymentSchema.safeParse(guest).success).toBe(true);
    expect(
      guestDeploymentSchema.safeParse({ ...guest, cpu: undefined }).success,
    ).toBe(false);
  });

  it('keeps unmodelled Proxmox keys under extra and rejects them elsewhere', () => {
    expect(
      guestDeploymentSchema.safeParse({ ...guest, extra: { lock: 'backup' } })
        .success,
    ).toBe(true);
    expect(
      guestDeploymentSchema.safeParse({ ...guest, lock: 'backup' }).success,
    ).toBe(false);
  });

  it('allows null to clear inherited keys in layer files only', () => {
    const layer = { schema_version: 1, cpu: null, ram: 1024 };
    expect(parseConfig('deployment-defaults', layer).ok).toBe(true);
    expect(
      guestDeploymentSchema.safeParse({ ...guest, cpu: null }).success,
    ).toBe(false);
  });

  it('accepts tagged values and rejects malformed ones', () => {
    expect(
      guestDeploymentSchema.safeParse({
        ...guest,
        cpu: { tag: 'expr', value: '2' },
      }).success,
    ).toBe(true);
    expect(
      guestDeploymentSchema.safeParse({
        ...guest,
        cpu: { tag: 'bogus', value: '2' },
      }).success,
    ).toBe(false);
    expect(isTagValue({ tag: 'env' })).toBe(false);
  });

  it('keeps world-writable mounts an explicit opt-in', () => {
    const parsed = guestDeploymentSchema.parse({
      ...guest,
      mounts: [{ host_path: '/opt/data', guest_path: '/opt' }],
    });
    expect(parsed.mounts?.[0]).toMatchObject({
      index: 0,
      permissions: 'minimal',
    });
  });

  it('accepts per-mount owners and an explicit LXC idmap', () => {
    const parsed = guestDeploymentSchema.parse({
      ...guest,
      unprivileged: true,
      idmap: { uid_base: 200_000, gid_base: 300_000, size: 65_536 },
      mounts: [
        {
          host_path: '/opt/data',
          guest_path: '/opt',
          owner: { uid: 1000, gid: 1000 },
          permissions: 'world_writable',
        },
      ],
    });
    expect(parsed).toMatchObject({
      idmap: { uid_base: 200_000, gid_base: 300_000, size: 65_536 },
    });
    expect(parsed.mounts?.[0]).toMatchObject({
      owner: { uid: 1000, gid: 1000 },
      permissions: 'world_writable',
    });
    expect(
      guestDeploymentSchema.safeParse({
        ...guest,
        mounts: [
          {
            host_path: '/opt/data',
            guest_path: '/opt',
            owner: { uid: -1, gid: 0 },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      guestDeploymentSchema.safeParse({
        ...guest,
        idmap: { uid_base: -1 },
      }).success,
    ).toBe(false);
  });

  it('accepts every installation variant', () => {
    const installs = [
      { type: 'template', template: 'local:vztmpl/x.tar.zst' },
      {
        type: 'community_script',
        url: 'https://example.invalid/s.sh',
        pinned_commit: 'abcdef1',
      },
      { type: 'clone', template_id: 9000 },
      { type: 'cloud_image', url: 'https://example.invalid/i.img' },
    ];
    for (const installation of installs) {
      expect(
        guestDeploymentSchema.safeParse({ ...guest, installation }).success,
      ).toBe(true);
    }
  });

  it('formats issues with an empty path for the document root', () => {
    const result = configSchemas.secrets.safeParse([]);
    if (result.success) throw new Error('should fail');
    expect(formatIssues(result.error.issues)[0]?.path).toBe('');
  });
});

describe('parseConfig and migrations', () => {
  it('rejects non-mappings and future versions', () => {
    expect(parseConfig('secrets', 'text')).toMatchObject({
      ok: false,
      issues: [{ code: 'not_an_object' }],
    });
    expect(
      parseConfig('secrets', { schema_version: 2, values: {} }),
    ).toMatchObject({
      ok: false,
      issues: [{ code: 'unsupported_version' }],
    });
    expect(migrateDocument('secrets', []).ok).toBe(false);
  });

  it('runs registered migrations in order', () => {
    const toTwo: Migration = (doc) => ({ ...doc, upgraded: true });
    const result = migrateDocument(
      'secrets',
      { schema_version: 1 },
      { secrets: { 1: toTwo } },
      2,
    );
    expect(result).toEqual({
      ok: true,
      migrated: true,
      document: { schema_version: 2, upgraded: true },
    });
  });

  it('fails when a migration step is missing', () => {
    expect(
      migrateDocument('secrets', { schema_version: 1 }, {}, 2),
    ).toMatchObject({
      ok: false,
      code: 'unsupported_version',
    });
  });

  it('reports migrated: false for current documents', () => {
    expect(
      parseConfig('secrets', { schema_version: 1, values: { a: 'b' } }),
    ).toMatchObject({
      ok: true,
      migrated: false,
    });
  });
});

describe('generated artifacts', () => {
  it('produces an editor JSON Schema per kind with tags as strings', () => {
    const schemas = allEditorJsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual([...configKinds].sort());
    const host = JSON.stringify(toEditorJsonSchema('host'));
    expect(host).toContain('Tagged value');
    expect(host).not.toContain('hacmKind');
    expect(host).toContain(
      '"$schema":"https://json-schema.org/draft/2020-12/schema"',
    );
  });

  it('keeps docs/reference/config.md in sync with the schemas', () => {
    const path = join(root, 'docs/reference/config.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).toBe(
      `${renderConfigReference()}\n`,
    );
  });
});

describe('schemaToRows', () => {
  it('documents nested unions, nullable keys, enums and unlabeled variants', () => {
    const rows = schemaToRows({
      type: 'object',
      required: ['a'],
      properties: {
        a: {
          anyOf: [{ type: 'string', enum: ['x', 'y'] }, { type: 'null' }],
          description: 'd',
        },
        b: {
          anyOf: [
            {
              type: 'object',
              properties: { k: { const: 'one' }, v: { type: 'number' } },
            },
            { type: 'object', properties: { w: { type: 'string' } } },
          ],
        },
        c: {
          anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
        },
        d: { type: 'array' },
        e: { oneOf: [{ type: 'string' }] },
      },
    });
    const byPath = new Map(
      rows.map((row) => [`${row.path}|${row.condition}`, row]),
    );
    expect(byPath.get('a|')).toMatchObject({
      type: '`x` \\| `y`',
      required: true,
    });
    expect(byPath.get('b.v|k = one')).toBeDefined();
    expect(byPath.get('b.w|')).toBeDefined();
    expect(byPath.get('c|')?.type).toBe('string \\| number');
    expect(byPath.get('d|')?.type).toBe('array of any');
    expect(byPath.get('e|')?.type).toBe('any');
  });
});
