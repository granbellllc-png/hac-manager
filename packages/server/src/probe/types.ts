export interface HostStorageProbe {
  readonly name: string;
  readonly type: string;
  readonly content: readonly string[];
  readonly total?: number | undefined;
  readonly used?: number | undefined;
  readonly avail?: number | undefined;
  readonly shared: boolean;
}

export interface HostProbeResult {
  readonly hostId: string;
  readonly pveVersion: string;
  readonly isCluster: boolean;
  readonly clusterName?: string | undefined;
  readonly storages: readonly HostStorageProbe[];
  readonly tools: Readonly<Record<string, boolean>>;
  readonly warnings: readonly string[];
  readonly probedAt: string;
}
