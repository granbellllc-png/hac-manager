import type { HostConnectionRouter } from '../router/router.js';
import type { ProxmoxClient } from '../proxmox/client.js';
import type { HostProbeResult, HostStorageProbe } from './types.js';

export class HostProber {
  public async probe(
    hostId: string,
    router: HostConnectionRouter,
    apiClient?: ProxmoxClient,
    node = 'localhost',
  ): Promise<HostProbeResult> {
    const warnings: string[] = [];

    // 1. PVE Version
    let pveVersion = 'unknown';
    if (apiClient) {
      try {
        const nodeStatus = await apiClient.getNodeStatus(node);
        pveVersion = nodeStatus.pveversion ?? 'unknown';
      } catch {
        // Fall back to SSH
      }
    }

    if (pveVersion === 'unknown') {
      try {
        const res = await router.exec(['pveversion']);
        if (res.exitCode === 0) {
          pveVersion = res.stdout.trim();
        }
      } catch {
        pveVersion = 'unknown';
      }
    }

    // 2. Cluster check
    let isCluster = false;
    let clusterName: string | undefined = undefined;

    if (apiClient) {
      try {
        const clusterStatus = await apiClient.getClusterStatus();
        const clusterEntry = clusterStatus.find(
          (item) => item.type === 'cluster',
        );
        const nodeEntries = clusterStatus.filter(
          (item) => item.type === 'node',
        );

        if (clusterEntry && typeof clusterEntry.name === 'string') {
          clusterName = clusterEntry.name;
        }

        if (nodeEntries.length > 1 || (clusterName && clusterName.length > 0)) {
          isCluster = true;
        }
      } catch {
        // Fall back to SSH
      }
    }

    if (!isCluster) {
      try {
        const pvecmRes = await router.exec(['pvecm', 'status']);
        if (pvecmRes.exitCode === 0) {
          const matchCluster = pvecmRes.stdout.match(
            /Cluster Name:\s+([^\r\n]+)/i,
          );
          if (matchCluster && matchCluster[1]) {
            clusterName = matchCluster[1].trim();
          }
          const matchNodes = pvecmRes.stdout.match(/Nodes:\s+(\d+)/i);
          const nodeCount =
            matchNodes && matchNodes[1] ? parseInt(matchNodes[1], 10) : 1;
          if (clusterName || nodeCount > 1) {
            isCluster = true;
          }
        }
      } catch {
        // Ignored
      }
    }

    if (isCluster) {
      warnings.push(
        `Host '${hostId}' is member of a Proxmox cluster '${clusterName ?? 'unknown'}'. Clusters are unsupported in v1; operations may conflict (D-25, D-26).`,
      );
    }

    // 3. Storages
    const storages: HostStorageProbe[] = [];
    if (apiClient) {
      try {
        const apiStorages = await apiClient.getStorages(node);
        for (const s of apiStorages) {
          const contentList =
            typeof s.content === 'string'
              ? s.content
                  .split(',')
                  .map((c) => c.trim())
                  .filter(Boolean)
              : [];
          storages.push({
            name: s.storage,
            type: s.type,
            content: contentList,
            total: s.total,
            used: s.used,
            avail: s.avail,
            shared: Boolean(s.shared),
          });
        }
      } catch {
        // Fall back to SSH
      }
    }

    if (storages.length === 0) {
      try {
        const pvesmRes = await router.exec(['pvesm', 'status']);
        if (pvesmRes.exitCode === 0) {
          const lines = pvesmRes.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          // Skip header
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            const parts = line.split(/\s+/);
            if (parts.length >= 2) {
              const name = parts[0] ?? '';
              const type = parts[1] ?? 'unknown';
              storages.push({
                name,
                type,
                content: ['rootdir', 'images'], // default standard for active storages
                shared: false,
              });
            }
          }
        }
      } catch {
        // Ignored
      }
    }

    // 4. Installed tools check via SSH
    const tools: Record<string, boolean> = {
      setfacl: false,
      rsync: false,
      restic: false,
      nsenter: false,
    };

    try {
      const toolCheckRes = await router.exec([
        'which',
        'setfacl',
        'rsync',
        'restic',
        'nsenter',
      ]);
      const output = toolCheckRes.stdout;
      tools.setfacl = output.includes('setfacl');
      tools.rsync = output.includes('rsync');
      tools.restic = output.includes('restic');
      tools.nsenter = output.includes('nsenter');
    } catch {
      // If which fails or SSH unavailable
    }

    if (!tools.setfacl) {
      warnings.push(
        `Tool 'setfacl' is missing on host '${hostId}'. LXC ACL mapping and mp0 preparation may fail.`,
      );
    }
    if (!tools.rsync) {
      warnings.push(
        `Tool 'rsync' is missing on host '${hostId}'. Fast file synchronization will fall back to tar/sftp.`,
      );
    }

    return {
      hostId,
      pveVersion,
      isCluster,
      clusterName,
      storages,
      tools,
      warnings,
      probedAt: new Date().toISOString(),
    };
  }
}
