import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultNodeFileSystem } from '../yaml/file.js';
import { getLineCol, validateDataDir } from './validate.js';
import { scanDataDir } from '../data-dir/discovery.js';

let directory: string;
let guestFile: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hacm-validation-fixture-'));
  await cp(
    resolve(import.meta.dirname, '../../../../examples/data'),
    directory,
    { recursive: true },
  );
  guestFile = join(
    directory,
    'hosts/example-host/112-example-lxc/deployment.yaml',
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('data validation boundaries', () => {
  it('discovers .yml tasks at all three tiers and ignores unrelated files', async () => {
    for (const relative of [
      'global-tasks',
      'hosts/example-host/tasks',
      'hosts/example-host/112-example-lxc/tasks',
    ]) {
      await writeFile(
        join(directory, relative, '10-fixture.yml'),
        'schema_version: 1\ntasks: []\n',
      );
      await writeFile(join(directory, relative, 'README.txt'), 'fixture');
    }
    const result = await scanDataDir(directory);
    expect(
      result.dataDir.globalTasks.some((task) => task.name === '10-fixture.yml'),
    ).toBe(true);
    expect(
      result.dataDir.hosts[0]?.tasks.some(
        (task) => task.name === '10-fixture.yml',
      ),
    ).toBe(true);
    expect(
      result.dataDir.hosts[0]?.guests[0]?.tasks.some(
        (task) => task.name === '10-fixture.yml',
      ),
    ).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('validates a standalone guest file without host defaults', async () => {
    await rm(join(directory, 'hosts/example-host/default-deployment.yaml'));
    const result = await validateDataDir({ dataDir: directory });
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.path === 'cpu')).toBe(true);
  });

  it('reports an invalid file that disappears after scanning', async () => {
    await writeFile(guestFile, 'schema_version: 1\nid: invalid\n');
    const reads = new Map<string, number>();
    const result = await validateDataDir({
      dataDir: directory,
      fs: {
        ...defaultNodeFileSystem,
        readFile: async (path, encoding) => {
          const normalized = resolve(path);
          const count = (reads.get(normalized) ?? 0) + 1;
          reads.set(normalized, count);
          if (count > 1 && path.includes('112-example-lxc'))
            throw new Error('fixture disappeared');
          return readFile(path, encoding);
        },
      },
    });
    expect(result.issues.some((issue) => issue.code === 'invalid_config')).toBe(
      true,
    );
  });
  it('locates a source offset and clips positions past end of file', () => {
    expect(getLineCol('a\nbc', 3)).toEqual({ line: 2, column: 2 });
    expect(getLineCol('a\nbc', 100)).toEqual({ line: 2, column: 3 });
    expect(getLineCol('', 0)).toEqual({ line: 1, column: 1 });
  });

  it.each([
    [
      'schema_version: 1\nid: 112\nname: example-lxc\ntype: lxc\ncpu: false\n',
      'invalid_type',
    ],
    [
      'schema_version: 1\nid: 112\nname: example-lxc\ntype: lxc\ndisks: []\nextra: {values: [null, text, {index: none}]}\n',
      undefined,
    ],
    [
      'schema_version: 1\nid: 112\nname: example-lxc\ntype: lxc\ncpu: !expr "process.exit()"\n',
      'invalid_expr',
    ],
    [
      'schema_version: 1\nid: 112\nname: example-lxc\ntype: lxc\nextra:\n  imported: !include ../../../../outside.yaml\n',
      'invalid_include',
    ],
    [
      'schema_version: 1\nid: 112\nname: example-lxc\ntype: lxc\nnetwork:\n  - index: 0\n    mtu: invalid\n',
      'invalid_type',
    ],
  ])(
    'validates guest content and reports the relevant source',
    async (content, code) => {
      await writeFile(guestFile, content);
      const result = await validateDataDir({ dataDir: directory });
      if (code) {
        expect(result.valid).toBe(false);
        expect(
          result.issues.some(
            (issue) =>
              issue.code === code && issue.file.includes('deployment.yaml'),
          ),
        ).toBe(true);
      } else {
        expect(result.issues).toEqual([]);
      }
    },
  );

  it('resolves a confined include offline', async () => {
    const guestDir = join(directory, 'hosts/example-host/112-example-lxc');
    await writeFile(join(guestDir, 'shared.yaml'), 'value: fixture\n');
    await writeFile(
      guestFile,
      'schema_version: 1\nid: 112\nname: example-lxc\ntype: lxc\nextra:\n  imported: !include shared.yaml\n',
    );
    const result = await validateDataDir({ dataDir: directory });
    expect(
      result.issues.filter((issue) => issue.code === 'invalid_include'),
    ).toEqual([]);
  });

  it.each(['cpu: invalid', 'cpu: !expr "1 / 0"'])(
    'attributes inherited failure to the defaults: %s',
    async (setting) => {
      await writeFile(
        join(directory, 'hosts/example-host/default-deployment.yaml'),
        `schema_version: 1\n${setting}\nram: 1024\n`,
      );
      await writeFile(
        guestFile,
        'schema_version: 1\nid: 112\nname: example-lxc\ntype: lxc\n',
      );
      const result = await validateDataDir({ dataDir: directory });
      expect(result.valid).toBe(false);
      expect(
        result.issues.some(
          (issue) =>
            issue.file.includes('default-deployment.yaml') &&
            issue.path === 'cpu',
        ),
      ).toBe(true);
    },
  );

  it('returns errors for syntax and missing required parent objects', async () => {
    await writeFile(
      join(directory, 'hosts/example-host/host.yaml'),
      'schema_version: 1\nid: example-host\nname: fixture\nindex: 1\ntype: proxmox\nconnection: {}\n',
    );
    await writeFile(guestFile, 'schema_version: 1\nid: [\n');
    const result = await validateDataDir({ dataDir: directory });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(1);
  });

  it('reports resolution errors, unresolved environment values, and locked providers separately', async () => {
    await writeFile(
      guestFile,
      'schema_version: 1\nid: 112\nname: example-lxc\ntype: lxc\nextra:\n  missing: !env ABSENT_FIXTURE\n  invalid: !expr "1 / 0"\n  locked: !secret fixture-key\n',
    );
    const result = await validateDataDir({
      dataDir: directory,
      resolve: true,
      env: {},
      secretProvider: {
        resolveSecret: async () => ({
          status: 'locked',
          reason: 'fixture vault locked',
        }),
      },
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'tag_error')).toBe(
      true,
    );
    expect(result.issues.some((issue) => issue.code === 'unresolved_tag')).toBe(
      true,
    );
    expect(result.issues.some((issue) => issue.code === 'locked_tag')).toBe(
      true,
    );
  });

  it('handles files disappearing after discovery without throwing', async () => {
    const reads = new Map<string, number>();
    const result = await validateDataDir({
      dataDir: directory,
      fs: {
        ...defaultNodeFileSystem,
        readFile: async (path, encoding) => {
          const normalized = resolve(path);
          const count = (reads.get(normalized) ?? 0) + 1;
          reads.set(normalized, count);
          if (count > 1 && /deployment\.yaml$/.test(path))
            throw new Error('fixture removed after scan');
          return readFile(path, encoding);
        },
      },
    });
    expect(result.stats.hosts).toBe(1);
  });
});
