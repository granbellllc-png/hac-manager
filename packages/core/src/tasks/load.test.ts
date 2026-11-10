import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileSystem } from '../yaml/file.js';
import { loadTaskFile, loadTaskFiles } from './load.js';
import { TaskLoadError } from './types.js';

class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();

  public addFile(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }

  public async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  public async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  public async stat(path: string) {
    if (!this.files.has(path)) throw new Error(`ENOENT: ${path}`);
    return {
      mode: 0o644,
      isDirectory: () => false,
      isFile: () => true,
    };
  }

  public async readdir(): Promise<string[]> {
    return [...this.files.keys()];
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content === undefined) throw new Error(`ENOENT: ${oldPath}`);
    this.files.delete(oldPath);
    this.files.set(newPath, content);
  }

  public async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const dataDir = '/data';

function tasksFile(tasks: string, extra = ''): string {
  return `schema_version: 1\n${extra}tasks:\n${tasks}`;
}

describe('loadTaskFile', () => {
  it('loads targets and tasks from one file', async () => {
    const fs = new MemoryFileSystem().addFile(
      '/data/global-tasks/010-setup.yaml',
      tasksFile(
        [
          '  - name: install',
          '    run: echo install',
          '    creates: /opt/installed',
          '    env:',
          '      MODE: prod',
          '    shell: bash',
        ].join('\n'),
        'targets:\n  groups:\n    - prod\n  tags:\n    - ssd\n',
      ),
    );
    const loaded = await loadTaskFile(
      { name: '010-setup.yaml', path: '/data/global-tasks/010-setup.yaml' },
      dataDir,
      { fs },
    );
    expect(loaded.file).toBe('010-setup.yaml');
    expect(loaded.absolutePath).toBe('/data/global-tasks/010-setup.yaml');
    expect(loaded.targets).toEqual({ groups: ['prod'], tags: ['ssd'] });
    expect(loaded.tasks).toHaveLength(1);
    expect(loaded.tasks[0]).toMatchObject({
      name: 'install',
      run: 'echo install',
      creates: '/opt/installed',
      env: { MODE: 'prod' },
      shell: 'bash',
    });
  });

  it('omits targets when the file declares none', async () => {
    const fs = new MemoryFileSystem().addFile(
      '/data/tasks/a.yaml',
      tasksFile('  - name: a\n    run: "true"'),
    );
    const loaded = await loadTaskFile(
      { name: 'a.yaml', path: '/data/tasks/a.yaml' },
      dataDir,
      { fs },
    );
    expect(loaded.targets).toBeUndefined();
    expect('targets' in loaded).toBe(false);
  });

  it('expands list, nested, tasks-file and single-task includes', async () => {
    const fs = new MemoryFileSystem()
      .addFile(
        '/data/tasks/010-main.yaml',
        tasksFile(
          [
            '  - name: first',
            '    run: echo first',
            '  - !include child.yaml',
            '  - !include /tasks/absolute.yaml',
          ].join('\n'),
        ),
      )
      .addFile(
        '/data/tasks/child.yaml',
        [
          '- name: child',
          '  run: echo child',
          '- !include nested/deep.yaml',
          '- name: tail',
          '  run: echo tail',
        ].join('\n'),
      )
      .addFile('/data/tasks/nested/deep.yaml', 'name: deep\nrun: echo deep')
      .addFile(
        '/data/tasks/absolute.yaml',
        tasksFile('  - name: absolute\n    run: echo absolute'),
      );

    const loaded = await loadTaskFile(
      { name: '010-main.yaml', path: '/data/tasks/010-main.yaml' },
      dataDir,
      { fs },
    );
    expect(loaded.tasks.map((task) => task.name)).toEqual([
      'first',
      'child',
      'deep',
      'tail',
      'absolute',
    ]);
  });

  it('rejects unsupported tags in a tasks list', async () => {
    const fs = new MemoryFileSystem().addFile(
      '/data/tasks/a.yaml',
      tasksFile('  - !env HOME'),
    );
    await expect(
      loadTaskFile({ name: 'a.yaml', path: '/data/tasks/a.yaml' }, dataDir, {
        fs,
      }),
    ).rejects.toThrow(/only !include is allowed/);
  });

  it('rejects traversal, cycles, missing files and bad include contents', async () => {
    const traversal = new MemoryFileSystem().addFile(
      '/data/tasks/a.yaml',
      tasksFile('  - !include ../secret.yaml'),
    );
    await expect(
      loadTaskFile({ name: 'a.yaml', path: '/data/tasks/a.yaml' }, dataDir, {
        fs: traversal,
      }),
    ).rejects.toThrow(/Path traversal forbidden/);

    const outside = new MemoryFileSystem().addFile(
      '/data/tasks/a.yaml',
      tasksFile('  - !include C:/outside.yaml'),
    );
    await expect(
      loadTaskFile({ name: 'a.yaml', path: '/data/tasks/a.yaml' }, dataDir, {
        fs: outside,
      }),
    ).rejects.toThrow(/resolves outside data directory/);

    const cycle = new MemoryFileSystem()
      .addFile('/data/tasks/a.yaml', tasksFile('  - !include b.yaml'))
      .addFile('/data/tasks/b.yaml', '- !include a.yaml');
    await expect(
      loadTaskFile({ name: 'a.yaml', path: '/data/tasks/a.yaml' }, dataDir, {
        fs: cycle,
      }),
    ).rejects.toThrow(/Circular !include/);

    const missing = new MemoryFileSystem().addFile(
      '/data/tasks/a.yaml',
      tasksFile('  - !include nope.yaml'),
    );
    await expect(
      loadTaskFile({ name: 'a.yaml', path: '/data/tasks/a.yaml' }, dataDir, {
        fs: missing,
      }),
    ).rejects.toThrow(/Failed to load !include file/);

    const scalar = new MemoryFileSystem()
      .addFile('/data/tasks/a.yaml', tasksFile('  - !include b.yaml'))
      .addFile('/data/tasks/b.yaml', 'just text');
    await expect(
      loadTaskFile({ name: 'a.yaml', path: '/data/tasks/a.yaml' }, dataDir, {
        fs: scalar,
      }),
    ).rejects.toThrow(/must contain a task/);
  });

  it('reports unreadable, unparseable and invalid files', async () => {
    const missing = new MemoryFileSystem();
    await expect(
      loadTaskFile({ name: 'gone.yaml', path: '/data/gone.yaml' }, dataDir, {
        fs: missing,
      }),
    ).rejects.toThrow(/Invalid tasks file 'gone.yaml': cannot read file/);

    const broken = new MemoryFileSystem().addFile(
      '/data/tasks/a.yaml',
      'schema_version: 1\ntasks: *missing',
    );
    await expect(
      loadTaskFile({ name: 'a.yaml', path: '/data/tasks/a.yaml' }, dataDir, {
        fs: broken,
      }),
    ).rejects.toThrow(/YAML parse error/);

    const invalid = new MemoryFileSystem().addFile(
      '/data/tasks/a.yaml',
      tasksFile('  - name: ""\n    run: echo'),
    );
    await expect(
      loadTaskFile({ name: 'a.yaml', path: '/data/tasks/a.yaml' }, dataDir, {
        fs: invalid,
      }),
    ).rejects.toThrow(TaskLoadError);
  });

  it('rejects an include entry that fails the task schema', async () => {
    const fs = new MemoryFileSystem()
      .addFile('/data/tasks/a.yaml', tasksFile('  - !include b.yaml'))
      .addFile('/data/tasks/b.yaml', '- name: b\n  run: echo\n  extra: nope');
    await expect(
      loadTaskFile({ name: 'a.yaml', path: '/data/tasks/a.yaml' }, dataDir, {
        fs,
      }),
    ).rejects.toThrow(/Invalid tasks file '\/data\/tasks\/b.yaml'/);
  });
});

describe('loadTaskFiles', () => {
  it('loads files in filename-prefix order', async () => {
    const fs = new MemoryFileSystem()
      .addFile(
        '/data/tasks/20-b.yaml',
        tasksFile('  - name: b\n    run: "true"'),
      )
      .addFile(
        '/data/tasks/3-a.yaml',
        tasksFile('  - name: a\n    run: "true"'),
      )
      .addFile('/data/tasks/c.yaml', tasksFile('  - name: c\n    run: "true"'));
    const loaded = await loadTaskFiles(
      [
        { name: 'c.yaml', path: '/data/tasks/c.yaml' },
        { name: '20-b.yaml', path: '/data/tasks/20-b.yaml' },
        { name: '3-a.yaml', path: '/data/tasks/3-a.yaml' },
      ],
      dataDir,
      { fs },
    );
    expect(loaded.map((file) => file.file)).toEqual([
      '3-a.yaml',
      '20-b.yaml',
      'c.yaml',
    ]);
  });
});

describe('loadTaskFile with the default file system', () => {
  it('reads tasks files from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hacm-tasks-'));
    try {
      const file = join(dir, 'tasks.yaml');
      await writeFile(
        file,
        tasksFile('  - name: disk\n    run: echo disk'),
        'utf8',
      );
      const loaded = await loadTaskFile(
        { name: 'tasks.yaml', path: file },
        dir,
      );
      expect(loaded.tasks.map((task) => task.name)).toEqual(['disk']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
