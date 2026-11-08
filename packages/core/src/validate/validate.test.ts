import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileSystem } from '../yaml/file.js';
import { validateDataDir } from './validate.js';

describe('validateDataDir', () => {
  const examplesDataDir = resolve(__dirname, '../../../../examples/data');

  it('passes on examples/data directory', async () => {
    const result = await validateDataDir({ dataDir: examplesDataDir });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.stats.hosts).toBe(1);
    expect(result.stats.guests).toBe(2);
    expect(result.stats.files).toBeGreaterThan(5);
  });

  it('fails with file:line when a fixture has schema type errors', async () => {
    const memFs: Record<string, string> = {
      'data/hosts/h1/host.yaml': `schema_version: 1
id: h1
name: h1
type: proxmox
index: 1
ignored_guests: []
`,
      'data/hosts/h1/100-bad/deployment.yaml': `schema_version: 1
id: 100
name: bad
type: lxc
cpu: two
ram: 2048
disks:
  - name: rootfs
    storage: local-lvm
    size_gb: 10
network:
  - index: 0
`,
    };

    const mockFs: FileSystem = {
      async readFile(p: string) {
        const norm = p.replaceAll('\\', '/').replace(/^\/+/, '');
        for (const [k, v] of Object.entries(memFs)) {
          if (norm.endsWith(k)) return v;
        }
        throw new Error(`File not found: ${p}`);
      },
      async writeFile() {},
      async stat(p: string) {
        const norm = p.replaceAll('\\', '/');
        const isDir =
          norm.endsWith('data') ||
          norm.endsWith('hosts') ||
          norm.endsWith('h1') ||
          norm.endsWith('100-bad');
        const isFile =
          norm.endsWith('host.yaml') || norm.endsWith('deployment.yaml');
        if (!isDir && !isFile) throw new Error(`Not found: ${p}`);
        return {
          mode: 0o755,
          isDirectory: () => isDir,
          isFile: () => isFile,
        };
      },
      async readdir(p: string) {
        const norm = p.replaceAll('\\', '/');
        if (norm.endsWith('hosts')) return ['h1'];
        if (norm.endsWith('h1')) return ['100-bad'];
        if (norm.endsWith('data')) return ['hosts'];
        return [];
      },
      async rename() {},
      async unlink() {},
    };

    const result = await validateDataDir({
      dataDir: 'data',
      fs: mockFs,
    });

    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    const cpuIssue = result.issues.find((i) => i.path === 'cpu');
    expect(cpuIssue).toBeDefined();
    expect(cpuIssue?.file).toContain('deployment.yaml');
    expect(cpuIssue?.line).toBe(5);
    expect(cpuIssue?.column).toBe(6);
  });

  it('fails with file:line when expression fails evaluation', async () => {
    const memFs: Record<string, string> = {
      'data/hosts/h1/host.yaml': `schema_version: 1
id: h1
name: h1
type: proxmox
index: 100
ignored_guests: []
`,
      'data/hosts/h1/100-bad/deployment.yaml': `schema_version: 1
id: 100
name: bad
type: lxc
cpu: 2
ram: 2048
disks:
  - name: rootfs
    storage: local-lvm
    size_gb: 10
network:
  - index: 0
    mac: !expr "mac('A2:B1:C1', host.index, net.index, vmid)"
`,
    };

    const mockFs: FileSystem = {
      async readFile(p: string) {
        const norm = p.replaceAll('\\', '/').replace(/^\/+/, '');
        for (const [k, v] of Object.entries(memFs)) {
          if (norm.endsWith(k)) return v;
        }
        throw new Error(`File not found: ${p}`);
      },
      async writeFile() {},
      async stat(p: string) {
        const norm = p.replaceAll('\\', '/');
        const isDir =
          norm.endsWith('data') ||
          norm.endsWith('hosts') ||
          norm.endsWith('h1') ||
          norm.endsWith('100-bad');
        const isFile =
          norm.endsWith('host.yaml') || norm.endsWith('deployment.yaml');
        if (!isDir && !isFile) throw new Error(`Not found: ${p}`);
        return {
          mode: 0o755,
          isDirectory: () => isDir,
          isFile: () => isFile,
        };
      },
      async readdir(p: string) {
        const norm = p.replaceAll('\\', '/');
        if (norm.endsWith('hosts')) return ['h1'];
        if (norm.endsWith('h1')) return ['100-bad'];
        if (norm.endsWith('data')) return ['hosts'];
        return [];
      },
      async rename() {},
      async unlink() {},
    };

    const result = await validateDataDir({
      dataDir: 'data',
      fs: mockFs,
    });

    expect(result.valid).toBe(false);
    const exprIssue = result.issues.find((i) => i.code === 'invalid_expr');
    expect(exprIssue).toBeDefined();
    expect(exprIssue?.message).toContain('host.index must be an integer');
  });

  it('fails when merged deployment is missing required fields from both layers', async () => {
    const memFs: Record<string, string> = {
      'data/hosts/h1/host.yaml': `schema_version: 1
id: h1
name: h1
type: proxmox
index: 1
ignored_guests: []
`,
      'data/hosts/h1/default-deployment.yaml': `schema_version: 1
ram: 2048
`,
      'data/hosts/h1/100-incomplete/deployment.yaml': `schema_version: 1
id: 100
name: incomplete
type: lxc
`,
    };

    const mockFs: FileSystem = {
      async readFile(p: string) {
        const norm = p.replaceAll('\\', '/').replace(/^\/+/, '');
        for (const [k, v] of Object.entries(memFs)) {
          if (norm.endsWith(k)) return v;
        }
        throw new Error(`File not found: ${p}`);
      },
      async writeFile() {},
      async stat(p: string) {
        const norm = p.replaceAll('\\', '/');
        const isDir =
          norm.endsWith('data') ||
          norm.endsWith('hosts') ||
          norm.endsWith('h1') ||
          norm.endsWith('100-incomplete');
        const isFile =
          norm.endsWith('host.yaml') ||
          norm.endsWith('default-deployment.yaml') ||
          norm.endsWith('deployment.yaml');
        if (!isDir && !isFile) throw new Error(`Not found: ${p}`);
        return {
          mode: 0o755,
          isDirectory: () => isDir,
          isFile: () => isFile,
        };
      },
      async readdir(p: string) {
        const norm = p.replaceAll('\\', '/');
        if (norm.endsWith('hosts')) return ['h1'];
        if (norm.endsWith('h1')) return ['100-incomplete'];
        if (norm.endsWith('data')) return ['hosts'];
        return [];
      },
      async rename() {},
      async unlink() {},
    };

    const result = await validateDataDir({
      dataDir: 'data',
      fs: mockFs,
    });

    expect(result.valid).toBe(false);
    const cpuIssue = result.issues.find(
      (i) =>
        i.path === 'cpu' && i.message.includes('Merged deployment invalid'),
    );
    expect(cpuIssue).toBeDefined();
  });
});
