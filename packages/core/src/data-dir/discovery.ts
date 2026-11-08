import { parseConfig } from '../schema/parse.js';
import type { ConfigKind, ConfigOf } from '../schema/registry.js';
import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';
import { loadYamlDocument, yamlDocumentToJS } from '../yaml/document.js';
import { computeDataDirVersionHash, hashContent } from './hash.js';
import type {
  DataDirValidationIssue,
  DiscoveredDataDir,
  DiscoveredGuest,
  DiscoveredHost,
  DiscoveredTaskFile,
} from './types.js';

function normalizeSlash(path: string): string {
  return path.replaceAll('\\', '/');
}

function joinPath(...parts: string[]): string {
  return parts
    .map((part) => normalizeSlash(part).replace(/\/+$/, ''))
    .filter(Boolean)
    .join('/');
}

async function tryStat(fs: FileSystem, path: string) {
  try {
    return await fs.stat(path);
  } catch {
    return undefined;
  }
}

async function tryReaddir(fs: FileSystem, path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}

async function loadAndValidateConfig<K extends ConfigKind>(
  fs: FileSystem,
  fullPath: string,
  relPath: string,
  kind: K,
  issues: DataDirValidationIssue[],
  fileHashes: Record<string, string>,
): Promise<ConfigOf<K> | undefined> {
  let content: string;
  try {
    content = await fs.readFile(fullPath, 'utf8');
  } catch (err) {
    issues.push({
      code: 'missing_file',
      message: `Failed to read ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      path: relPath,
    });
    return undefined;
  }

  fileHashes[relPath] = await hashContent(content);

  let doc;
  try {
    doc = loadYamlDocument(content);
  } catch (err) {
    issues.push({
      code: 'invalid_config',
      message: `Failed to parse YAML in ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      path: relPath,
    });
    return undefined;
  }

  const parsed = parseConfig(kind, yamlDocumentToJS(doc));
  if (!parsed.ok) {
    issues.push({
      code: 'invalid_config',
      message: `Invalid ${kind} file at ${relPath}: ${parsed.issues.map((i) => i.message).join('; ')}`,
      path: relPath,
      details: parsed.issues,
    });
    return undefined;
  }

  return parsed.value;
}

export async function scanDataDir(
  dataDir: string,
  fs: FileSystem = defaultNodeFileSystem,
): Promise<{
  readonly dataDir: DiscoveredDataDir;
  readonly issues: readonly DataDirValidationIssue[];
}> {
  const normDataDir = normalizeSlash(dataDir);
  const issues: DataDirValidationIssue[] = [];
  const fileHashes: Record<string, string> = {};

  const dirStat = await tryStat(fs, normDataDir);
  if (!dirStat || !dirStat.isDirectory()) {
    issues.push({
      code: 'missing_file',
      message: `Data directory does not exist or is not a directory: ${normDataDir}`,
      path: normDataDir,
    });
    return {
      dataDir: {
        dataDir: normDataDir,
        globalTasks: [],
        hosts: [],
        fileHashes: {},
        versionHash: await computeDataDirVersionHash({}),
      },
      issues,
    };
  }

  // 1. Secrets
  let secretsFile: string | undefined = undefined;
  let relativeSecretsFile: string | undefined = undefined;
  const secretsFullPath = joinPath(normDataDir, 'secrets.yaml');
  const secretsStat = await tryStat(fs, secretsFullPath);
  if (secretsStat && secretsStat.isFile()) {
    secretsFile = secretsFullPath;
    relativeSecretsFile = 'secrets.yaml';
    await loadAndValidateConfig(
      fs,
      secretsFullPath,
      relativeSecretsFile,
      'secrets',
      issues,
      fileHashes,
    );
  }

  // 2. Global tasks (Tier 1)
  const globalTasks: DiscoveredTaskFile[] = [];
  const globalTasksDir = joinPath(normDataDir, 'global-tasks');
  const globalTasksStat = await tryStat(fs, globalTasksDir);
  if (globalTasksStat && globalTasksStat.isDirectory()) {
    const entries = (await tryReaddir(fs, globalTasksDir)).sort();
    for (const entry of entries) {
      if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
        const fullPath = joinPath(globalTasksDir, entry);
        const relPath = joinPath('global-tasks', entry);
        await loadAndValidateConfig(
          fs,
          fullPath,
          relPath,
          'tasks',
          issues,
          fileHashes,
        );
        globalTasks.push({
          name: entry,
          path: fullPath,
          relativePath: relPath,
          tier: 1,
        });
      }
    }
  }

  // 3. Hosts
  const hosts: DiscoveredHost[] = [];
  const hostsDir = joinPath(normDataDir, 'hosts');
  const hostsStat = await tryStat(fs, hostsDir);
  const seenHostIds = new Set<string>();
  const seenHostIndexes = new Map<number, string>();

  if (hostsStat && hostsStat.isDirectory()) {
    const hostEntries = (await tryReaddir(fs, hostsDir)).sort();
    for (const hostDirName of hostEntries) {
      const hostFullPath = joinPath(hostsDir, hostDirName);
      const hostDirStat = await tryStat(fs, hostFullPath);
      if (!hostDirStat || !hostDirStat.isDirectory()) continue;

      const hostRelativeDir = joinPath('hosts', hostDirName);
      const hostFileFullPath = joinPath(hostFullPath, 'host.yaml');
      const hostFileStat = await tryStat(fs, hostFileFullPath);
      const relativeHostFile = joinPath(hostRelativeDir, 'host.yaml');

      let hostName = hostDirName;
      if (!hostFileStat || !hostFileStat.isFile()) {
        issues.push({
          code: 'missing_file',
          message: `Host directory "${hostRelativeDir}" is missing host.yaml`,
          path: relativeHostFile,
        });
      } else {
        const parsedHost = await loadAndValidateConfig(
          fs,
          hostFileFullPath,
          relativeHostFile,
          'host',
          issues,
          fileHashes,
        );

        if (parsedHost) {
          hostName = parsedHost.name;
          if (parsedHost.id !== hostDirName) {
            issues.push({
              code: 'folder_name_mismatch',
              message: `Host folder name "${hostDirName}" does not match host.yaml id "${parsedHost.id}"`,
              path: relativeHostFile,
            });
          }
          if (seenHostIds.has(parsedHost.id)) {
            issues.push({
              code: 'duplicate_host_id',
              message: `Duplicate host id "${parsedHost.id}"`,
              path: relativeHostFile,
            });
          } else {
            seenHostIds.add(parsedHost.id);
          }
          if (typeof parsedHost.index === 'number') {
            const prev = seenHostIndexes.get(parsedHost.index);
            if (prev) {
              issues.push({
                code: 'duplicate_host_index',
                message: `Host "${parsedHost.id}" has duplicate host.index ${parsedHost.index} (already used by "${prev}")`,
                path: relativeHostFile,
              });
            } else {
              seenHostIndexes.set(parsedHost.index, parsedHost.id);
            }
          }
        }
      }

      // Default deployment
      let defaultDeploymentFile: string | undefined = undefined;
      let relativeDefaultDeploymentFile: string | undefined = undefined;
      const defDepFull = joinPath(hostFullPath, 'default-deployment.yaml');
      const defDepStat = await tryStat(fs, defDepFull);
      if (defDepStat && defDepStat.isFile()) {
        defaultDeploymentFile = defDepFull;
        relativeDefaultDeploymentFile = joinPath(
          hostRelativeDir,
          'default-deployment.yaml',
        );
        await loadAndValidateConfig(
          fs,
          defDepFull,
          relativeDefaultDeploymentFile,
          'deployment-defaults',
          issues,
          fileHashes,
        );
      }

      // Default filemappings
      let defaultFilemappingsFile: string | undefined = undefined;
      let relativeDefaultFilemappingsFile: string | undefined = undefined;
      const defFmFull = joinPath(hostFullPath, 'default-filemappings.yaml');
      const defFmStat = await tryStat(fs, defFmFull);
      if (defFmStat && defFmStat.isFile()) {
        defaultFilemappingsFile = defFmFull;
        relativeDefaultFilemappingsFile = joinPath(
          hostRelativeDir,
          'default-filemappings.yaml',
        );
        await loadAndValidateConfig(
          fs,
          defFmFull,
          relativeDefaultFilemappingsFile,
          'filemappings',
          issues,
          fileHashes,
        );
      }

      // Host tasks (Tier 2)
      const hostTasks: DiscoveredTaskFile[] = [];
      const hostTasksDir = joinPath(hostFullPath, 'tasks');
      const hostTasksStat = await tryStat(fs, hostTasksDir);
      if (hostTasksStat && hostTasksStat.isDirectory()) {
        const entries = (await tryReaddir(fs, hostTasksDir)).sort();
        for (const entry of entries) {
          if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
            const fullPath = joinPath(hostTasksDir, entry);
            const relPath = joinPath(hostRelativeDir, 'tasks', entry);
            await loadAndValidateConfig(
              fs,
              fullPath,
              relPath,
              'tasks',
              issues,
              fileHashes,
            );
            hostTasks.push({
              name: entry,
              path: fullPath,
              relativePath: relPath,
              tier: 2,
            });
          }
        }
      }

      // Guests
      const guests: DiscoveredGuest[] = [];
      const seenVmidsOnHost = new Set<number>();
      const subEntries = (await tryReaddir(fs, hostFullPath)).sort();

      for (const sub of subEntries) {
        if (sub === 'tasks' || sub === 'appdata' || sub.startsWith('.'))
          continue;
        const guestFullDir = joinPath(hostFullPath, sub);
        const subStat = await tryStat(fs, guestFullDir);
        if (!subStat || !subStat.isDirectory()) continue;

        const guestRelDir = joinPath(hostRelativeDir, sub);
        const match = /^(\d+)-(.*)$/.exec(sub);
        if (!match) {
          issues.push({
            code: 'invalid_folder_name',
            message: `Guest directory "${guestRelDir}" must be in the format "<vmid>-<name>"`,
            path: guestRelDir,
          });
          continue;
        }

        const folderVmid = Number.parseInt(match[1]!, 10);
        const folderName = match[2]!;

        if (seenVmidsOnHost.has(folderVmid)) {
          issues.push({
            code: 'duplicate_vmid',
            message: `Duplicate VMID ${folderVmid} on host "${hostDirName}" in "${guestRelDir}"`,
            path: guestRelDir,
          });
        } else {
          seenVmidsOnHost.add(folderVmid);
        }

        const depFull = joinPath(guestFullDir, 'deployment.yaml');
        const depStat = await tryStat(fs, depFull);
        const relDep = joinPath(guestRelDir, 'deployment.yaml');

        if (!depStat || !depStat.isFile()) {
          issues.push({
            code: 'missing_file',
            message: `Guest directory "${guestRelDir}" is missing deployment.yaml`,
            path: relDep,
          });
          continue;
        }

        const parsedDep = await loadAndValidateConfig(
          fs,
          depFull,
          relDep,
          'deployment',
          issues,
          fileHashes,
        );

        if (parsedDep) {
          if (parsedDep.id !== folderVmid) {
            issues.push({
              code: 'folder_name_mismatch',
              message: `Folder VMID ${folderVmid} does not match deployment id ${parsedDep.id}`,
              path: relDep,
            });
          }
          if (parsedDep.name !== folderName) {
            issues.push({
              code: 'folder_name_mismatch',
              message: `Folder name "${folderName}" does not match deployment name "${parsedDep.name}"`,
              path: relDep,
            });
          }
        }

        // filemappings.yaml
        let filemappingsFile: string | undefined = undefined;
        let relativeFilemappingsFile: string | undefined = undefined;
        const fmFull = joinPath(guestFullDir, 'filemappings.yaml');
        const fmStat = await tryStat(fs, fmFull);
        if (fmStat && fmStat.isFile()) {
          filemappingsFile = fmFull;
          relativeFilemappingsFile = joinPath(guestRelDir, 'filemappings.yaml');
          await loadAndValidateConfig(
            fs,
            fmFull,
            relativeFilemappingsFile,
            'filemappings',
            issues,
            fileHashes,
          );
        }

        // appdata/
        let appdataDir: string | undefined = undefined;
        let relativeAppdataDir: string | undefined = undefined;
        const adFull = joinPath(guestFullDir, 'appdata');
        const adStat = await tryStat(fs, adFull);
        if (adStat && adStat.isDirectory()) {
          appdataDir = adFull;
          relativeAppdataDir = joinPath(guestRelDir, 'appdata');
        }

        // guest tasks (Tier 3)
        const guestTasks: DiscoveredTaskFile[] = [];
        const gTasksDir = joinPath(guestFullDir, 'tasks');
        const gTasksStat = await tryStat(fs, gTasksDir);
        if (gTasksStat && gTasksStat.isDirectory()) {
          const entries = (await tryReaddir(fs, gTasksDir)).sort();
          for (const entry of entries) {
            if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
              const fullPath = joinPath(gTasksDir, entry);
              const relPath = joinPath(guestRelDir, 'tasks', entry);
              await loadAndValidateConfig(
                fs,
                fullPath,
                relPath,
                'tasks',
                issues,
                fileHashes,
              );
              guestTasks.push({
                name: entry,
                path: fullPath,
                relativePath: relPath,
                tier: 3,
              });
            }
          }
        }

        const guestResult: DiscoveredGuest = {
          hostId: hostDirName,
          vmid: folderVmid,
          name: folderName,
          folderName: sub,
          dir: guestFullDir,
          relativeDir: guestRelDir,
          deploymentFile: depFull,
          relativeDeploymentFile: relDep,
          ...(filemappingsFile !== undefined
            ? { filemappingsFile, relativeFilemappingsFile }
            : {}),
          ...(appdataDir !== undefined
            ? { appdataDir, relativeAppdataDir }
            : {}),
          tasks: guestTasks,
        };
        guests.push(guestResult);
      }

      const hostResult: DiscoveredHost = {
        id: hostDirName,
        name: hostName,
        dir: hostFullPath,
        relativeDir: hostRelativeDir,
        hostFile: hostFileFullPath,
        relativeHostFile,
        ...(defaultDeploymentFile !== undefined
          ? { defaultDeploymentFile, relativeDefaultDeploymentFile }
          : {}),
        ...(defaultFilemappingsFile !== undefined
          ? { defaultFilemappingsFile, relativeDefaultFilemappingsFile }
          : {}),
        tasks: hostTasks,
        guests,
      };
      hosts.push(hostResult);
    }
  }

  const versionHash = await computeDataDirVersionHash(fileHashes);

  const discoveredDataDir: DiscoveredDataDir = {
    dataDir: normDataDir,
    ...(secretsFile !== undefined ? { secretsFile, relativeSecretsFile } : {}),
    globalTasks,
    hosts,
    fileHashes,
    versionHash,
  };

  return { dataDir: discoveredDataDir, issues };
}
