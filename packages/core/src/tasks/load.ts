import { dirname, normalize, resolve } from 'node:path';
import { toErrorMessage } from '../errors.js';
import { isTagValue } from '../schema/common.js';
import { taskSchema, tasksFileSchema } from '../schema/tasks.js';
import { resolveSandboxedInclude } from '../tags/include.js';
import { loadYamlDocument, yamlDocumentToJS } from '../yaml/document.js';
import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';
import { orderTaskFiles, type TaskTargets } from './order.js';
import { TaskLoadError, type LoadedTaskFile, type Task } from './types.js';

export interface TaskFileRef {
  readonly name: string;
  readonly path: string;
}

export interface LoadTaskFilesOptions {
  readonly fs?: FileSystem | undefined;
}

function normalizePath(path: string): string {
  return normalize(path).replace(/\\/g, '/');
}

function formatIssues(issues: readonly { message: string }[]): string {
  return issues.map((issue) => issue.message).join('; ');
}

function parseTask(value: unknown, file: string): Task {
  const parsed = taskSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaskLoadError(file, formatIssues(parsed.error.issues));
  }
  return parsed.data;
}

function taskEntries(value: unknown, file: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { tasks?: unknown }).tasks)
  ) {
    return (value as { tasks: unknown[] }).tasks;
  }
  if (typeof value === 'object' && value !== null) return [value];
  throw new TaskLoadError(
    file,
    'a task include must contain a task, a list of tasks or a tasks file',
  );
}

async function expandEntries(
  entries: readonly unknown[],
  file: string,
  currentDir: string,
  dataDir: string,
  fs: FileSystem,
  includedPaths: ReadonlySet<string>,
): Promise<Task[]> {
  const tasks: Task[] = [];
  for (const entry of entries) {
    if (isTagValue(entry) && entry.tag === 'include') {
      const included = await resolveSandboxedInclude(
        entry.value,
        dataDir,
        currentDir,
        fs,
        includedPaths,
      );
      if (included.status !== 'resolved') {
        throw new TaskLoadError(file, included.error);
      }
      const next = new Set(includedPaths);
      next.add(included.resolvedPath);
      tasks.push(
        ...(await expandEntries(
          taskEntries(included.value, included.resolvedPath),
          included.resolvedPath,
          dirname(included.resolvedPath),
          dataDir,
          fs,
          next,
        )),
      );
      continue;
    }
    if (isTagValue(entry)) {
      throw new TaskLoadError(
        file,
        `unsupported '!${entry.tag}' tag in a tasks list; only !include is allowed here`,
      );
    }
    tasks.push(parseTask(entry, file));
  }
  return tasks;
}

/**
 * Load one tasks file, expanding `!include` recursively and enforcing the
 * data-dir sandbox, cycle detection and the task schema on every entry.
 */
export async function loadTaskFile(
  file: TaskFileRef,
  dataDir: string,
  options: LoadTaskFilesOptions = {},
): Promise<LoadedTaskFile> {
  const fs = options.fs ?? defaultNodeFileSystem;
  let content: string;
  try {
    content = await fs.readFile(file.path, 'utf8');
  } catch (error) {
    throw new TaskLoadError(
      file.name,
      `cannot read file: ${toErrorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = yamlDocumentToJS(loadYamlDocument(content));
  } catch (error) {
    throw new TaskLoadError(
      file.name,
      `YAML parse error: ${toErrorMessage(error)}`,
    );
  }

  const fileSchema = tasksFileSchema.safeParse(parsed);
  if (!fileSchema.success) {
    throw new TaskLoadError(file.name, formatIssues(fileSchema.error.issues));
  }

  const absolutePath = resolve(file.path);
  const includedPaths = new Set([normalizePath(absolutePath)]);
  const tasks = await expandEntries(
    fileSchema.data.tasks,
    file.name,
    dirname(absolutePath),
    dataDir,
    fs,
    includedPaths,
  );

  return {
    file: file.name,
    absolutePath,
    ...(fileSchema.data.targets !== undefined
      ? { targets: fileSchema.data.targets as TaskTargets }
      : {}),
    tasks,
  };
}

/** Load and order task files by their leading filename prefix. */
export async function loadTaskFiles(
  files: readonly TaskFileRef[],
  dataDir: string,
  options: LoadTaskFilesOptions = {},
): Promise<readonly LoadedTaskFile[]> {
  return Promise.all(
    orderTaskFiles(files).map((file) =>
      loadTaskFile({ name: file.name, path: file.path }, dataDir, options),
    ),
  );
}
