import { describe, expect, it } from 'vitest';
import { WriteGuard } from '../data-dir/write-guard.js';
import type { FileSystem } from '../yaml/file.js';
import { applyPatch } from './apply-patch.js';

describe('applyPatch Writeback API', () => {
  function createMockFs(initialFiles: Record<string, string>) {
    const files = { ...initialFiles };

    const fs: FileSystem = {
      async readFile(p: string) {
        const norm = p.replaceAll('\\', '/');
        if (files[norm] !== undefined) return files[norm];
        throw new Error(`File not found: ${p}`);
      },
      async writeFile(p: string, content: string) {
        const norm = p.replaceAll('\\', '/');
        files[norm] = content;
      },
      async stat(p: string) {
        const norm = p.replaceAll('\\', '/');
        const exists = files[norm] !== undefined;
        if (!exists) throw new Error(`Not found: ${p}`);
        return {
          mode: 0o644,
          isDirectory: () => false,
          isFile: () => true,
        };
      },
      async readdir() {
        return [];
      },
      async rename(oldP: string, newP: string) {
        const o = oldP.replaceAll('\\', '/');
        const n = newP.replaceAll('\\', '/');
        if (files[o] !== undefined) {
          files[n] = files[o];
          delete files[o];
        }
      },
      async unlink(p: string) {
        const norm = p.replaceAll('\\', '/');
        delete files[norm];
      },
    };

    return { fs, files };
  }

  it('updates guest override property in guest deployment file', async () => {
    const { fs, files } = createMockFs({
      'hosts/h1/default-deployment.yaml': `schema_version: 1
cpu: 2
ram: 2048
`,
      'hosts/h1/112-test/deployment.yaml': `# Main container deployment
schema_version: 1
id: 112
name: test
type: lxc
# Custom disk size
disks:
  - name: rootfs
    storage: local-lvm
    size_gb: 10
`,
    });

    const result = await applyPatch(
      {
        deploymentFile: 'hosts/h1/112-test/deployment.yaml',
        defaultDeploymentFile: 'hosts/h1/default-deployment.yaml',
      },
      ['disks', 0, 'size_gb'],
      20,
      { fs },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.targetFile).toBe('hosts/h1/112-test/deployment.yaml');
      expect(result.layer).toBe('override');
      expect(result.newValue).toBe(20);
      expect(result.overriddenInGuest).toBe(false);
    }

    const updated = files['hosts/h1/112-test/deployment.yaml']!;
    expect(updated).toContain('size_gb: 20');
    expect(updated).toContain('# Main container deployment');
    expect(updated).toContain('# Custom disk size');
  });

  it('updates default property in default-deployment.yaml when forceOverride is false', async () => {
    const { fs, files } = createMockFs({
      'hosts/h1/default-deployment.yaml': `# Shared host defaults
schema_version: 1
cpu: 2
ram: 2048
`,
      'hosts/h1/112-test/deployment.yaml': `schema_version: 1
id: 112
name: test
type: lxc
`,
    });

    const result = await applyPatch(
      {
        deploymentFile: 'hosts/h1/112-test/deployment.yaml',
        defaultDeploymentFile: 'hosts/h1/default-deployment.yaml',
      },
      'ram',
      4096,
      { fs },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.targetFile).toBe('hosts/h1/default-deployment.yaml');
      expect(result.layer).toBe('default');
      expect(result.newValue).toBe(4096);
      expect(result.overriddenInGuest).toBe(false);
    }

    const updatedDefault = files['hosts/h1/default-deployment.yaml']!;
    expect(updatedDefault).toContain('ram: 4096');
    expect(updatedDefault).toContain('# Shared host defaults');
    const guestFile = files['hosts/h1/112-test/deployment.yaml']!;
    expect(guestFile).not.toContain('ram');
  });

  it('writes override into guest deployment when forceOverride is true', async () => {
    const { fs, files } = createMockFs({
      'hosts/h1/default-deployment.yaml': `schema_version: 1
cpu: 2
ram: 2048
`,
      'hosts/h1/112-test/deployment.yaml': `schema_version: 1
id: 112
name: test
type: lxc
`,
    });

    const result = await applyPatch(
      {
        deploymentFile: 'hosts/h1/112-test/deployment.yaml',
        defaultDeploymentFile: 'hosts/h1/default-deployment.yaml',
      },
      'cpu',
      4,
      { fs, forceOverride: true },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.targetFile).toBe('hosts/h1/112-test/deployment.yaml');
      expect(result.layer).toBe('override');
      expect(result.newValue).toBe(4);
      expect(result.overriddenInGuest).toBe(true);
    }

    const defaultFile = files['hosts/h1/default-deployment.yaml']!;
    expect(defaultFile).toContain('cpu: 2'); // untouched
    const guestFile = files['hosts/h1/112-test/deployment.yaml']!;
    expect(guestFile).toContain('cpu: 4');
  });

  it('refuses to patch tag-valued nodes (!expr, !env, !secret)', async () => {
    const { fs } = createMockFs({
      'hosts/h1/default-deployment.yaml': `schema_version: 1
gateway: !env GATEWAY_IP
password: !secret db_pass
`,
      'hosts/h1/112-test/deployment.yaml': `schema_version: 1
id: 112
name: test
type: lxc
network:
  - index: 0
    mac: !expr "mac('A2:B1:C1', host.index, net.index, vmid)"
`,
    });

    // 1. Refuse !expr
    const resExpr = await applyPatch(
      {
        deploymentFile: 'hosts/h1/112-test/deployment.yaml',
        defaultDeploymentFile: 'hosts/h1/default-deployment.yaml',
      },
      ['network', 0, 'mac'],
      'A2:B1:C1:01:E0:12',
      { fs },
    );

    expect(resExpr.success).toBe(false);
    if (!resExpr.success) {
      expect(resExpr.reason).toBe('tag_protected');
      expect(resExpr.tag).toBe('expr');
      expect(resExpr.rawTagValue).toContain('mac(');
      expect(resExpr.message).toContain('tag-valued node');
    }

    // 2. Refuse !env
    const resEnv = await applyPatch(
      {
        deploymentFile: 'hosts/h1/112-test/deployment.yaml',
        defaultDeploymentFile: 'hosts/h1/default-deployment.yaml',
      },
      'gateway',
      '192.168.1.1',
      { fs },
    );

    expect(resEnv.success).toBe(false);
    if (!resEnv.success) {
      expect(resEnv.reason).toBe('tag_protected');
      expect(resEnv.tag).toBe('env');
    }

    // 3. Refuse !secret
    const resSecret = await applyPatch(
      {
        deploymentFile: 'hosts/h1/112-test/deployment.yaml',
        defaultDeploymentFile: 'hosts/h1/default-deployment.yaml',
      },
      'password',
      'newpass',
      { fs },
    );

    expect(resSecret.success).toBe(false);
    if (!resSecret.success) {
      expect(resSecret.reason).toBe('tag_protected');
      expect(resSecret.tag).toBe('secret');
    }
  });

  it('detects external write conflict via write guard', async () => {
    const initialGuestYaml = `schema_version: 1
id: 112
name: test
type: lxc
cpu: 2
`;
    const { fs } = createMockFs({
      'hosts/h1/112-test/deployment.yaml': initialGuestYaml,
    });

    const guard = new WriteGuard();
    // Register stale hash
    guard.registerHash('hosts/h1/112-test/deployment.yaml', 'stale-hash-12345');

    const result = await applyPatch(
      { deploymentFile: 'hosts/h1/112-test/deployment.yaml' },
      'cpu',
      4,
      {
        fs,
        writeGuard: guard,
        expectedHash: 'stale-hash-12345',
      },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('write_conflict');
      expect(result.message).toContain('Write conflict');
    }
  });

  it('supports dryRun mode without modifying files on disk', async () => {
    const originalContent = `schema_version: 1
id: 112
name: test
type: lxc
cpu: 2
`;
    const { fs, files } = createMockFs({
      'hosts/h1/112-test/deployment.yaml': originalContent,
    });

    const result = await applyPatch(
      { deploymentFile: 'hosts/h1/112-test/deployment.yaml' },
      'cpu',
      8,
      { fs, dryRun: true },
    );

    expect(result.success).toBe(true);
    expect(files['hosts/h1/112-test/deployment.yaml']).toBe(originalContent);
  });
});
