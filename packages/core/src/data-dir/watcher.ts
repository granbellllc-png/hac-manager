import { EventEmitter } from 'node:events';
import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';
import { scanDataDir } from './discovery.js';
import type { DataDirValidationIssue, DiscoveredDataDir } from './types.js';

export interface WatcherEvent {
  readonly eventType: string;
  readonly filename?: string | null | undefined;
}

export type WatchProvider = (
  dir: string,
  listener: (eventType: string, filename: string | null) => void,
) => { close: () => void };

export const defaultNodeWatchProvider: WatchProvider = (dir, listener) => {
  let rawWatcher: { close: () => void } | undefined = undefined;
  import('node:fs').then(({ watch }) => {
    try {
      rawWatcher = watch(dir, { recursive: true }, (event, filename) => {
        listener(event, filename);
      });
    } catch {
      // ignore if dir was deleted during setup
    }
  });

  return {
    close() {
      rawWatcher?.close();
    },
  };
};

export interface DataDirWatcherOptions {
  readonly debounceMs?: number | undefined;
  readonly fs?: FileSystem | undefined;
  readonly watchProvider?: WatchProvider | undefined;
}

export interface DataDirWatcherChangeEvent {
  readonly dataDir: DiscoveredDataDir;
  readonly issues: readonly DataDirValidationIssue[];
  readonly changedFiles: readonly string[];
}

export class DataDirWatcher extends EventEmitter {
  private currentDataDir: DiscoveredDataDir | undefined = undefined;
  private currentIssues: readonly DataDirValidationIssue[] = [];
  private activeWatcher: { close: () => void } | undefined = undefined;
  private debounceTimer: NodeJS.Timeout | undefined = undefined;
  private readonly pendingChanges = new Set<string>();
  private running = false;
  private readonly debounceMs: number;
  private readonly fs: FileSystem;
  private readonly watchProvider: WatchProvider;

  public constructor(
    public readonly dataDir: string,
    options: DataDirWatcherOptions = {},
  ) {
    super();
    this.debounceMs = options.debounceMs ?? 100;
    this.fs = options.fs ?? defaultNodeFileSystem;
    this.watchProvider = options.watchProvider ?? defaultNodeWatchProvider;
  }

  public getIndex(): {
    readonly dataDir: DiscoveredDataDir;
    readonly issues: readonly DataDirValidationIssue[];
  } {
    if (!this.currentDataDir) {
      throw new Error('DataDirWatcher has not been started yet');
    }
    return { dataDir: this.currentDataDir, issues: this.currentIssues };
  }

  public async start(): Promise<{
    readonly dataDir: DiscoveredDataDir;
    readonly issues: readonly DataDirValidationIssue[];
  }> {
    if (this.running) {
      return this.getIndex();
    }
    this.running = true;

    const initial = await scanDataDir(this.dataDir, this.fs);
    this.currentDataDir = initial.dataDir;
    this.currentIssues = initial.issues;

    this.activeWatcher = this.watchProvider(
      this.dataDir,
      (_event, filename) => {
        if (filename) {
          this.pendingChanges.add(filename.replaceAll('\\', '/'));
        }
        this.scheduleRescan();
      },
    );

    this.emit('ready', {
      dataDir: this.currentDataDir,
      issues: this.currentIssues,
    });
    return { dataDir: this.currentDataDir, issues: this.currentIssues };
  }

  public async rescan(): Promise<{
    readonly dataDir: DiscoveredDataDir;
    readonly issues: readonly DataDirValidationIssue[];
  }> {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    const changedFiles = Array.from(this.pendingChanges);
    this.pendingChanges.clear();

    const result = await scanDataDir(this.dataDir, this.fs);
    const oldVersion = this.currentDataDir?.versionHash;
    this.currentDataDir = result.dataDir;
    this.currentIssues = result.issues;

    if (oldVersion !== result.dataDir.versionHash || changedFiles.length > 0) {
      this.emit('change', {
        dataDir: result.dataDir,
        issues: result.issues,
        changedFiles,
      } satisfies DataDirWatcherChangeEvent);
    }

    return { dataDir: result.dataDir, issues: result.issues };
  }

  private scheduleRescan(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.rescan().catch((err) => this.emit('error', err));
    }, this.debounceMs);
  }

  public close(): void {
    this.running = false;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.activeWatcher?.close();
    this.activeWatcher = undefined;
    this.pendingChanges.clear();
  }
}
