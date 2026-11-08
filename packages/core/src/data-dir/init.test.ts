import { describe, expect, it } from 'vitest';
import { validateDataDir } from '../validate/validate.js';
import type { FileSystem } from '../yaml/file.js';
import { initDataDir } from './init.js';

describe('initDataDir', () => {
  function createMemoryFs() {
    const files = new Map<string, string>();

    const fs: FileSystem = {
      async readFile(p: string) {
        const norm = p.replaceAll('\\', '/');
        const val = files.get(norm);
        if (val !== undefined) return val;
        throw new Error(`File not found: ${p}`);
      },
      async writeFile(p: string, content: string) {
        const norm = p.replaceAll('\\', '/');
        files.set(norm, content);
      },
      async stat(p: string) {
        const norm = p.replaceAll('\\', '/');
        if (files.has(norm)) {
          return { mode: 0o644, isDirectory: () => false, isFile: () => true };
        }
        // Check if any file starts with this directory prefix
        const prefix = norm.endsWith('/') ? norm : `${norm}/`;
        for (const k of files.keys()) {
          if (k.startsWith(prefix)) {
            return {
              mode: 0o755,
              isDirectory: () => true,
              isFile: () => false,
            };
          }
        }
        throw new Error(`Not found: ${p}`);
      },
      async readdir(p: string) {
        const norm = p.replaceAll('\\', '/');
        const prefix = norm.endsWith('/') ? norm : `${norm}/`;
        const entries = new Set<string>();
        for (const k of files.keys()) {
          if (k.startsWith(prefix)) {
            const rel = k.slice(prefix.length);
            const firstSeg = rel.split('/')[0]!;
            entries.add(firstSeg);
          }
        }
        return Array.from(entries);
      },
      async rename(oldP: string, newP: string) {
        const o = oldP.replaceAll('\\', '/');
        const n = newP.replaceAll('\\', '/');
        const val = files.get(o);
        if (val !== undefined) {
          files.set(n, val);
          files.delete(o);
        }
      },
      async unlink(p: string) {
        const norm = p.replaceAll('\\', '/');
        files.delete(norm);
      },
    };

    return { fs, files };
  }

  it('scaffolds a complete data directory safely', async () => {
    const { fs, files } = createMemoryFs();

    const result = await initDataDir({
      dataDir: 'infra-repo',
      hostId: 'pve-main',
      hostName: 'Proxmox Main',
      hostIp: '192.168.1.100',
      fs,
    });

    expect(result.dataDir).toBe('infra-repo');
    expect(result.hostId).toBe('pve-main');
    expect(result.actions.every((a) => a.status === 'created')).toBe(true);

    // Verify key files were created
    expect(files.has('infra-repo/.gitignore')).toBe(true);
    expect(files.has('infra-repo/secrets.yaml.example')).toBe(true);
    expect(files.has('infra-repo/secrets.yaml')).toBe(true);
    expect(files.has('infra-repo/global-tasks/00-inspect.yaml')).toBe(true);
    expect(files.has('infra-repo/hosts/pve-main/host.yaml')).toBe(true);
    expect(files.has('infra-repo/hosts/pve-main/default-deployment.yaml')).toBe(
      true,
    );
    expect(
      files.has('infra-repo/hosts/pve-main/default-filemappings.yaml'),
    ).toBe(true);
    expect(files.has('infra-repo/hosts/pve-main/tasks/00-inspect.yaml')).toBe(
      true,
    );

    // Verify contents
    const gitignore = files.get('infra-repo/.gitignore')!;
    expect(gitignore).toContain('secrets.yaml');
    expect(gitignore).toContain('.env');

    const hostYaml = files.get('infra-repo/hosts/pve-main/host.yaml')!;
    expect(hostYaml).toContain('id: pve-main');
    expect(hostYaml).toContain('name: Proxmox Main');
    expect(hostYaml).toContain('host: 192.168.1.100');
  });

  it('is idempotent: running twice skips existing files without overwriting', async () => {
    const { fs, files } = createMemoryFs();

    const firstRun = await initDataDir({
      dataDir: 'infra-repo',
      hostId: 'pve-main',
      fs,
    });
    expect(firstRun.actions.every((a) => a.status === 'created')).toBe(true);

    // User customized host.yaml
    const customizedHostYaml =
      files.get('infra-repo/hosts/pve-main/host.yaml')! +
      '# User custom comment\n';
    files.set('infra-repo/hosts/pve-main/host.yaml', customizedHostYaml);

    // Second run
    const secondRun = await initDataDir({
      dataDir: 'infra-repo',
      hostId: 'pve-main',
      fs,
    });
    expect(secondRun.actions.every((a) => a.status === 'skipped')).toBe(true);

    // Custom comment preserved
    expect(files.get('infra-repo/hosts/pve-main/host.yaml')).toBe(
      customizedHostYaml,
    );
  });

  it('generates a repo that passes validateDataDir', async () => {
    const { fs } = createMemoryFs();

    await initDataDir({
      dataDir: 'infra-repo',
      hostId: 'pve-main',
      fs,
    });

    const validation = await validateDataDir({
      dataDir: 'infra-repo',
      fs,
    });

    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.stats.hosts).toBe(1);
    expect(validation.stats.guests).toBe(0);
  });
});
