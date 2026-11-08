import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';

export interface InitDataDirOptions {
  /** Target data directory path */
  readonly dataDir: string;
  /** First host ID (default: 'pve-01') */
  readonly hostId?: string | undefined;
  /** First host display name (default: same as hostId) */
  readonly hostName?: string | undefined;
  /** First host IP or hostname (default: '192.0.2.10') */
  readonly hostIp?: string | undefined;
  /** Injected file system for testing */
  readonly fs?: FileSystem | undefined;
}

export interface InitFileAction {
  readonly path: string;
  readonly status: 'created' | 'skipped';
}

export interface InitDataDirResult {
  readonly dataDir: string;
  readonly hostId: string;
  readonly actions: readonly InitFileAction[];
}

function normalizeSlash(p: string): string {
  return p.replaceAll('\\', '/');
}

function joinPath(...parts: string[]): string {
  return parts
    .map((part) => normalizeSlash(part).replace(/\/+$/, ''))
    .filter(Boolean)
    .join('/');
}

export async function initDataDir(
  options: InitDataDirOptions,
): Promise<InitDataDirResult> {
  const fs: FileSystem = options.fs ?? defaultNodeFileSystem;
  const dataDir = normalizeSlash(options.dataDir);
  const hostId = options.hostId?.trim() || 'pve-01';
  const hostName = options.hostName?.trim() || hostId;
  const hostIp = options.hostIp?.trim() || '192.0.2.10';

  const actions: InitFileAction[] = [];

  async function writeFileIfMissing(
    relPath: string,
    content: string,
  ): Promise<void> {
    const fullPath = joinPath(dataDir, relPath);
    try {
      await fs.stat(fullPath);
      // File already exists; do not overwrite
      actions.push({ path: relPath, status: 'skipped' });
    } catch {
      // Ensure parent directory exists on physical disk when using defaultNodeFileSystem
      if (fs === defaultNodeFileSystem) {
        const { mkdir } = await import('node:fs/promises');
        const { dirname } = await import('node:path');
        const dir = dirname(fullPath);
        await mkdir(dir, { recursive: true });
      }
      // File missing; create it
      await fs.writeFile(fullPath, content);
      actions.push({ path: relPath, status: 'created' });
    }
  }

  // 1. .gitignore
  const gitignoreContent = `# HAC Manager data directory gitignore
secrets.yaml
.env
.env.*
!.env.yaml
*.tmp
`;
  await writeFileIfMissing('.gitignore', gitignoreContent);

  // 2. secrets.yaml.example
  const secretsExampleContent = `# yaml-language-server: $schema=./schemas/secrets.schema.json
schema_version: 1
values:
  proxmox_token_secret: changeme-token-secret
`;
  await writeFileIfMissing('secrets.yaml.example', secretsExampleContent);

  // 3. secrets.yaml (copied from example if untracked copy missing)
  await writeFileIfMissing('secrets.yaml', secretsExampleContent);

  // 4. global-tasks/00-inspect.yaml
  const globalTaskContent = `# yaml-language-server: $schema=../schemas/tasks.schema.json
schema_version: 1
tasks:
  - name: Inspect operating system
    run: cat /etc/os-release
    timeout: 30
`;
  await writeFileIfMissing('global-tasks/00-inspect.yaml', globalTaskContent);

  // 5. hosts/<hostId>/host.yaml
  const hostYamlContent = `# yaml-language-server: $schema=../../schemas/host.schema.json
schema_version: 1
id: ${hostId}
name: ${hostName}
type: proxmox
index: 1
connection:
  ssh:
    host: ${hostIp}
    port: 22
    username: root
  api:
    url: https://${hostIp}:8006
    token_id: root@pam!hacm
    token_secret: !secret proxmox_token_secret
ignored_guests: []
`;
  await writeFileIfMissing(`hosts/${hostId}/host.yaml`, hostYamlContent);

  // 6. hosts/<hostId>/default-deployment.yaml
  const defaultDeploymentContent = `# yaml-language-server: $schema=../../schemas/deployment-defaults.schema.json
schema_version: 1
cpu: 2
ram: 2048
network:
  - index: 0
    bridge: vmbr0
`;
  await writeFileIfMissing(
    `hosts/${hostId}/default-deployment.yaml`,
    defaultDeploymentContent,
  );

  // 7. hosts/<hostId>/default-filemappings.yaml
  const defaultFilemappingsContent = `# yaml-language-server: $schema=../../schemas/filemappings.schema.json
schema_version: 1
mappings: []
`;
  await writeFileIfMissing(
    `hosts/${hostId}/default-filemappings.yaml`,
    defaultFilemappingsContent,
  );

  // 8. hosts/<hostId>/tasks/00-inspect.yaml
  const hostTaskContent = `# yaml-language-server: $schema=../../../schemas/tasks.schema.json
schema_version: 1
tasks:
  - name: Inspect host version
    run: pveversion -v
    timeout: 30
`;
  await writeFileIfMissing(
    `hosts/${hostId}/tasks/00-inspect.yaml`,
    hostTaskContent,
  );

  return {
    dataDir,
    hostId,
    actions,
  };
}
