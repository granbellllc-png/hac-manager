import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeDataDirVersionHash,
  DataDirWatcher,
  defaultNodeFileSystem,
  hashContent,
  loadYamlDocument,
  scanDataDir,
  setScalar,
  WriteConflictError,
  WriteGuard,
  type FileSystem,
  type WatchProvider,
} from '../index.js';

const root = resolve(import.meta.dirname, '../../../..');
const exampleDataDir = join(root, 'examples/data');

describe('Data Directory Discovery on examples/data', () => {
  it('discovers all hosts, guests, tasks and computes version hash with zero issues', async () => {
    const { dataDir, issues } = await scanDataDir(exampleDataDir);

    expect(issues).toEqual([]);
    expect(dataDir.globalTasks).toHaveLength(1);
    expect(dataDir.globalTasks[0]?.name).toBe('00-inspect.yaml');
    expect(dataDir.globalTasks[0]?.tier).toBe(1);

    expect(dataDir.hosts).toHaveLength(1);
    const host = dataDir.hosts[0]!;
    expect(host.id).toBe('example-host');
    expect(host.name).toBe('example-host');
    expect(host.defaultDeploymentFile).toBeDefined();
    expect(host.defaultFilemappingsFile).toBeDefined();
    expect(host.tasks).toHaveLength(1);
    expect(host.tasks[0]?.tier).toBe(2);

    expect(host.guests).toHaveLength(2);
    const lxc = host.guests.find((g) => g.vmid === 112);
    expect(lxc).toBeDefined();
    expect(lxc?.name).toBe('example-lxc');
    expect(lxc?.folderName).toBe('112-example-lxc');
    expect(lxc?.filemappingsFile).toBeDefined();
    expect(lxc?.appdataDir).toBeDefined();
    expect(lxc?.tasks).toHaveLength(1);
    expect(lxc?.tasks[0]?.tier).toBe(3);

    const vm = host.guests.find((g) => g.vmid === 212);
    expect(vm).toBeDefined();
    expect(vm?.name).toBe('example-vm');
    expect(vm?.folderName).toBe('212-example-vm');
    expect(vm?.filemappingsFile).toBeDefined();
    expect(vm?.tasks).toHaveLength(1);

    expect(Object.keys(dataDir.fileHashes).length).toBeGreaterThan(5);
    expect(dataDir.versionHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Data Directory Validation Rules', () => {
  it('reports missing data directory', async () => {
    const { issues } = await scanDataDir('/non/existent/path/for/hacm/test');
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'missing_file' }),
    );
  });

  it('detects duplicate VMID on the same host', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'hacm-val-'));
    try {
      const hostDir = join(temp, 'hosts', 'host1');
      mkdirSync(join(hostDir, '100-alpha'), { recursive: true });
      mkdirSync(join(hostDir, '100-beta'), { recursive: true });

      writeFileSync(
        join(hostDir, 'host.yaml'),
        'schema_version: 1\nid: host1\nname: host1\ntype: proxmox\nindex: 1\nconnection:\n  ssh:\n    host: 192.0.2.1\n',
      );
      writeFileSync(
        join(hostDir, '100-alpha', 'deployment.yaml'),
        'schema_version: 1\nid: 100\nname: alpha\ntype: lxc\ncpu: 1\nram: 512\ndisks: []\nnetwork: []\n',
      );
      writeFileSync(
        join(hostDir, '100-beta', 'deployment.yaml'),
        'schema_version: 1\nid: 100\nname: beta\ntype: lxc\ncpu: 1\nram: 512\ndisks: []\nnetwork: []\n',
      );

      const { issues } = await scanDataDir(temp);
      const codes = issues.map((i) => i.code);
      expect(codes).toContain('duplicate_vmid');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('detects folder name vs id and name mismatch', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'hacm-val-'));
    try {
      const hostDir = join(temp, 'hosts', 'my-host');
      mkdirSync(join(hostDir, '110-wrong-name'), { recursive: true });

      writeFileSync(
        join(hostDir, 'host.yaml'),
        'schema_version: 1\nid: other-host-id\nname: my-host\ntype: proxmox\nindex: 1\nconnection:\n  ssh:\n    host: 192.0.2.1\n',
      );
      writeFileSync(
        join(hostDir, '110-wrong-name', 'deployment.yaml'),
        'schema_version: 1\nid: 111\nname: actual-name\ntype: lxc\ncpu: 1\nram: 512\ndisks: []\nnetwork: []\n',
      );

      const { issues } = await scanDataDir(temp);
      const hostMismatch = issues.find(
        (i) =>
          i.code === 'folder_name_mismatch' &&
          i.message.includes('Host folder name'),
      );
      expect(hostMismatch).toBeDefined();

      const vmidMismatch = issues.find(
        (i) =>
          i.code === 'folder_name_mismatch' &&
          i.message.includes('Folder VMID 110'),
      );
      expect(vmidMismatch).toBeDefined();

      const nameMismatch = issues.find(
        (i) =>
          i.code === 'folder_name_mismatch' &&
          i.message.includes('does not match deployment name'),
      );
      expect(nameMismatch).toBeDefined();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('detects invalid guest folder format, ignores non-dirs in hosts, duplicate host index and duplicate host id', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'hacm-val-'));
    try {
      const host1Dir = join(temp, 'hosts', 'h1');
      const host2Dir = join(temp, 'hosts', 'h2');
      const host3Dir = join(temp, 'hosts', 'h1-dup');
      mkdirSync(join(host1Dir, 'invalid_guest_folder'), { recursive: true });
      mkdirSync(host2Dir, { recursive: true });
      mkdirSync(host3Dir, { recursive: true });

      // Non-dir files inside hosts/ and hosts/h1/ should be ignored
      writeFileSync(join(temp, 'hosts', 'hosts-notes.txt'), 'ignore me');
      writeFileSync(join(host1Dir, 'notes.txt'), 'ignore me too');

      writeFileSync(
        join(host1Dir, 'host.yaml'),
        'schema_version: 1\nid: h1\nname: h1\ntype: proxmox\nindex: 2\nconnection:\n  ssh:\n    host: 192.0.2.1\n',
      );
      writeFileSync(
        join(host2Dir, 'host.yaml'),
        'schema_version: 1\nid: h2\nname: h2\ntype: proxmox\nindex: 2\nconnection:\n  ssh:\n    host: 192.0.2.2\n',
      );
      writeFileSync(
        join(host3Dir, 'host.yaml'),
        'schema_version: 1\nid: h1\nname: h1 duplicate\ntype: proxmox\nindex: 3\nconnection:\n  ssh:\n    host: 192.0.2.3\n',
      );

      const { issues } = await scanDataDir(temp);
      expect(issues).toContainEqual(
        expect.objectContaining({ code: 'invalid_folder_name' }),
      );
      expect(issues).toContainEqual(
        expect.objectContaining({ code: 'duplicate_host_index' }),
      );
      expect(issues).toContainEqual(
        expect.objectContaining({ code: 'duplicate_host_id' }),
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('detects missing host.yaml and missing deployment.yaml', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'hacm-val-'));
    try {
      const hostDir = join(temp, 'hosts', 'h1');
      mkdirSync(join(hostDir, '100-alpha'), { recursive: true });
      // host1 has no host.yaml, 100-alpha has no deployment.yaml

      const { issues } = await scanDataDir(temp);
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'missing_file',
          path: 'hosts/h1/host.yaml',
        }),
      );
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'missing_file',
          path: 'hosts/h1/100-alpha/deployment.yaml',
        }),
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('reports invalid YAML syntax or schema violation in config files', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'hacm-val-'));
    try {
      const hostDir = join(temp, 'hosts', 'h1');
      mkdirSync(join(hostDir, '100-app', 'tasks'), { recursive: true });
      mkdirSync(join(hostDir, 'tasks'), { recursive: true });
      mkdirSync(join(temp, 'global-tasks'), { recursive: true });

      writeFileSync(
        join(temp, 'secrets.yaml'),
        'schema_version: 1\nvalues: invalid_mapping\n',
      );
      writeFileSync(join(temp, 'global-tasks', 'bad.yaml'), 'invalid yaml: [}');
      writeFileSync(
        join(hostDir, 'host.yaml'),
        'schema_version: 1\nid: h1\nname: h1\ntype: proxmox\nindex: 1\nconnection:\n  ssh:\n    host: 192.0.2.1\n',
      );
      writeFileSync(
        join(hostDir, 'default-deployment.yaml'),
        'invalid yaml: [}',
      );
      writeFileSync(
        join(hostDir, 'default-filemappings.yaml'),
        'invalid yaml: [}',
      );
      writeFileSync(
        join(hostDir, 'tasks', 'bad-host-task.yaml'),
        'invalid yaml: [}',
      );
      writeFileSync(
        join(hostDir, '100-app', 'deployment.yaml'),
        'schema_version: 1\nid: 100\nname: app\ntype: lxc\ncpu: not_a_number\n',
      );
      writeFileSync(
        join(hostDir, '100-app', 'filemappings.yaml'),
        'invalid yaml: [}',
      );
      writeFileSync(
        join(hostDir, '100-app', 'tasks', 'bad-guest-task.yaml'),
        'invalid yaml: [}',
      );

      const { issues } = await scanDataDir(temp);
      const invalidIssues = issues.filter((i) => i.code === 'invalid_config');
      expect(invalidIssues.length).toBeGreaterThanOrEqual(8);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('handles read error during loadAndValidateConfig', async () => {
    const failingFs: FileSystem = {
      ...defaultNodeFileSystem,
      readFile: (path: string) => {
        if (path.includes('host.yaml')) {
          return Promise.reject(new Error('Permission denied'));
        }
        return defaultNodeFileSystem.readFile(path, 'utf8');
      },
    };

    const { issues } = await scanDataDir(exampleDataDir, failingFs);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'missing_file',
        message: expect.stringContaining('Failed to read'),
      }),
    );
  });
});

describe('Hash Utilities', () => {
  it('hashes string and Uint8Array identically', async () => {
    const text = 'hello world';
    const bytes = new TextEncoder().encode(text);
    const hashStr = await hashContent(text);
    const hashBytes = await hashContent(bytes);
    expect(hashStr).toBe(hashBytes);
    expect(hashStr).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });

  it('computes deterministic version hash', async () => {
    const hashes = { 'b.yaml': 'hash2', 'a.yaml': 'hash1' };
    const version1 = await computeDataDirVersionHash(hashes);
    const version2 = await computeDataDirVersionHash({
      'a.yaml': 'hash1',
      'b.yaml': 'hash2',
    });
    expect(version1).toBe(version2);
  });
});

describe('WriteGuard', () => {
  it('allows write when expectedHash matches and updates hash', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'hacm-wg-'));
    try {
      const file = join(temp, 'deployment.yaml');
      const initial = 'schema_version: 1\ncpu: 2\n';
      await writeFile(file, initial);
      const initialHash = await hashContent(initial);

      const guard = new WriteGuard();
      guard.registerHash(file, initialHash);
      expect(guard.getHash(file)).toBe(initialHash);

      const doc = loadYamlDocument(initial);
      setScalar(doc, 'cpu', 4);

      const { newHash } = await guard.writeWithGuard(file, doc, initialHash);
      expect(newHash).not.toBe(initialHash);
      expect(guard.getHash(file)).toBe(newHash);

      const written = await readFile(file, 'utf8');
      expect(written).toBe('schema_version: 1\ncpu: 4\n');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('refuses overwrite when file was modified externally (WriteConflictError)', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'hacm-wg-'));
    try {
      const file = join(temp, 'deployment.yaml');
      const initial = 'cpu: 2\n';
      await writeFile(file, initial);
      const initialHash = await hashContent(initial);

      // External IDE edit happens
      const externalEdit = 'cpu: 2 # edited in VSCode\n';
      await writeFile(file, externalEdit);

      const guard = new WriteGuard();
      const doc = loadYamlDocument(initial);
      setScalar(doc, 'cpu', 4);

      await expect(
        guard.writeWithGuard(file, doc, initialHash),
      ).rejects.toThrow(WriteConflictError);

      // Verify the external edit was preserved and not overwritten
      const current = await readFile(file, 'utf8');
      expect(current).toBe(externalEdit);

      guard.clear();
      expect(guard.getHash(file)).toBeUndefined();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('allows writing new file when expectedHash is empty and file does not exist', async () => {
    const guard = new WriteGuard();
    const canWrite = await guard.assertCanWrite('/non/existent/new.yaml', '');
    expect(canWrite).toBe('');
  });

  it('throws WriteConflictError if expected non-empty hash but file is missing', async () => {
    const guard = new WriteGuard();
    await expect(
      guard.assertCanWrite('/non/existent/missing.yaml', 'some-expected-hash'),
    ).rejects.toThrow(WriteConflictError);
  });

  it('propagates other file read errors in assertCanWrite', async () => {
    const guard = new WriteGuard();
    const customFs: FileSystem = {
      ...defaultNodeFileSystem,
      readFile: () => Promise.reject(new Error('Hardware failure')),
    };
    await expect(
      guard.assertCanWrite('/some/file.yaml', '', customFs),
    ).rejects.toThrow('Hardware failure');
  });
});

describe('DataDirWatcher', () => {
  it('throws getIndex if not started', () => {
    const watcher = new DataDirWatcher(exampleDataDir);
    expect(() => watcher.getIndex()).toThrow(
      'DataDirWatcher has not been started yet',
    );
  });

  it('initializes and triggers change when file is modified externally within 1s', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'hacm-watcher-'));
    try {
      const hostDir = join(temp, 'hosts', 'h1');
      mkdirSync(join(hostDir, '100-app'), { recursive: true });

      const hostContent =
        'schema_version: 1\nid: h1\nname: h1\ntype: proxmox\nindex: 1\nconnection:\n  ssh:\n    host: 192.0.2.1\n';
      const depContent =
        'schema_version: 1\nid: 100\nname: app\ntype: lxc\ncpu: 1\nram: 512\ndisks: []\nnetwork: []\n';

      await writeFile(join(hostDir, 'host.yaml'), hostContent);
      const depFile = join(hostDir, '100-app', 'deployment.yaml');
      await writeFile(depFile, depContent);

      const watcher = new DataDirWatcher(temp, { debounceMs: 50 });
      let readyCalled = false;
      watcher.on('ready', () => {
        readyCalled = true;
      });

      const initial = await watcher.start();
      expect(readyCalled).toBe(true);
      expect(initial.dataDir.hosts).toHaveLength(1);
      const initialVersion = initial.dataDir.versionHash;

      // Edit file externally
      const changePromise = new Promise<{
        changedFiles: readonly string[];
        version: string;
      }>((resolveEvent) => {
        watcher.on('change', (e) => {
          resolveEvent({
            changedFiles: e.changedFiles,
            version: e.dataDir.versionHash,
          });
        });
      });

      await writeFile(
        depFile,
        'schema_version: 1\nid: 100\nname: app\ntype: lxc\ncpu: 4\nram: 512\ndisks: []\nnetwork: []\n',
      );

      const changeEvent = await Promise.race([
        changePromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error('Watcher did not detect external edit within 1s'),
              ),
            950,
          ),
        ),
      ]);

      expect(changeEvent.version).not.toBe(initialVersion);
      expect(watcher.getIndex().dataDir.versionHash).toBe(changeEvent.version);

      watcher.close();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('supports simulated watch provider, null filename, and rescan without changes', async () => {
    let triggeredListener:
      ((event: string, filename: string | null) => void) | undefined;
    const mockWatchProvider: WatchProvider = (_dir, listener) => {
      triggeredListener = listener;
      return { close: () => undefined };
    };

    const watcher = new DataDirWatcher(exampleDataDir, {
      debounceMs: 20,
      watchProvider: mockWatchProvider,
    });

    await watcher.start();
    // Second start returns existing
    await watcher.start();

    // Trigger listener with null filename
    triggeredListener?.('change', null);

    // Calling rescan when nothing changed
    const rescanResult = await watcher.rescan();
    expect(rescanResult.dataDir).toBeDefined();

    const changePromise = new Promise<void>((resolveEvent) => {
      watcher.on('change', () => resolveEvent());
    });

    // Simulate change event
    triggeredListener?.('change', 'hosts/example-host/host.yaml');
    await changePromise;

    watcher.close();
  });

  it('handles and emits errors during watching', async () => {
    const watcher = new DataDirWatcher(exampleDataDir, { debounceMs: 10 });
    const errorPromise = new Promise<Error>((resolveErr) => {
      watcher.on('error', (err) => resolveErr(err as Error));
    });
    watcher.emit('error', new Error('Simulated watcher error'));
    const err = await errorPromise;
    expect(err.message).toBe('Simulated watcher error');
    watcher.close();
  });
});
