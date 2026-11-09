export interface RawProxmoxConfig {
  readonly main: Record<string, string>;
  readonly pending?: Record<string, string> | undefined;
  readonly snapshots?: Record<string, Record<string, string>> | undefined;
}

export function parseRawProxmoxConfig(text: string): RawProxmoxConfig {
  const lines = text.split(/\r?\n/);
  const main: Record<string, string> = {};
  const pending: Record<string, string> = {};
  const snapshots: Record<string, Record<string, string>> = {};

  let currentTarget: Record<string, string> = main;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const section = trimmed.slice(1, -1).trim();
      if (section === 'PENDING') {
        currentTarget = pending;
      } else {
        if (!snapshots[section]) {
          snapshots[section] = {};
        }
        currentTarget = snapshots[section]!;
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      currentTarget[key] = value;
    }
  }

  const result: RawProxmoxConfig = { main };
  if (Object.keys(pending).length > 0) {
    (result as { pending: Record<string, string> }).pending = pending;
  }
  if (Object.keys(snapshots).length > 0) {
    (
      result as { snapshots: Record<string, Record<string, string>> }
    ).snapshots = snapshots;
  }

  return result;
}

export function serialiseRawProxmoxConfig(config: RawProxmoxConfig): string {
  const lines: string[] = [];

  const mainKeys = Object.keys(config.main).sort();
  for (const k of mainKeys) {
    lines.push(`${k}: ${config.main[k]}`);
  }

  if (config.pending && Object.keys(config.pending).length > 0) {
    lines.push('');
    lines.push('[PENDING]');
    const pendingKeys = Object.keys(config.pending).sort();
    for (const k of pendingKeys) {
      lines.push(`${k}: ${config.pending[k]}`);
    }
  }

  if (config.snapshots) {
    const snapNames = Object.keys(config.snapshots).sort();
    for (const name of snapNames) {
      lines.push('');
      lines.push(`[${name}]`);
      const snapKeys = Object.keys(config.snapshots[name]!).sort();
      for (const k of snapKeys) {
        lines.push(`${k}: ${config.snapshots[name]![k]}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}
