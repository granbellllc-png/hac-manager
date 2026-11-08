import { normalize, resolve } from 'node:path';
import { loadYamlDocument, yamlDocumentToJS } from '../yaml/document.js';
import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';
import type { ResolvedTagError, ResolvedTagSuccess } from './types.js';

function normalizePath(p: string): string {
  return normalize(p).replace(/\\/g, '/');
}

function isInsideDataDir(targetPath: string, dataDir: string): boolean {
  const normTarget = normalizePath(targetPath).toLowerCase();
  const normDataDir = normalizePath(dataDir).toLowerCase();
  const prefix = normDataDir.endsWith('/') ? normDataDir : `${normDataDir}/`;
  return normTarget === normDataDir || normTarget.startsWith(prefix);
}

export async function resolveSandboxedInclude(
  includePath: string,
  dataDir: string,
  currentFileDir: string = dataDir,
  fs: FileSystem = defaultNodeFileSystem,
  includedPaths: ReadonlySet<string> = new Set(),
): Promise<
  | (ResolvedTagSuccess<unknown> & { readonly resolvedPath: string })
  | ResolvedTagError
> {
  const raw = includePath;

  // 1. Traversal check on raw string
  if (includePath.includes('..')) {
    return {
      status: 'error',
      tag: 'include',
      raw,
      error: `Path traversal forbidden: '${includePath}' contains '..'`,
    };
  }

  // 2. Resolve absolute path
  let targetPath: string;
  if (includePath.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(includePath)) {
    // If given an absolute path, it must resolve inside dataDir
    targetPath = resolve(dataDir, includePath.replace(/^[/\\]+/, ''));
  } else {
    targetPath = resolve(currentFileDir, includePath);
  }

  const normTarget = normalizePath(targetPath);
  const normDataDir = normalizePath(dataDir);

  if (!isInsideDataDir(normTarget, normDataDir)) {
    return {
      status: 'error',
      tag: 'include',
      raw,
      error: `Path traversal forbidden: include path '${includePath}' resolves outside data directory`,
    };
  }

  // 3. Cycle detection
  if (includedPaths.has(normTarget)) {
    return {
      status: 'error',
      tag: 'include',
      raw,
      error: `Circular !include detected: '${normTarget}' is already being evaluated`,
    };
  }

  // 4. Read and parse file
  try {
    const content = await fs.readFile(targetPath, 'utf8');
    const doc = loadYamlDocument(content);
    const value = yamlDocumentToJS(doc);

    return {
      status: 'resolved',
      tag: 'include',
      raw,
      value,
      resolvedPath: normTarget,
    };
  } catch (err) {
    return {
      status: 'error',
      tag: 'include',
      raw,
      error: `Failed to load !include file '${includePath}': ${(err as Error).message}`,
    };
  }
}
