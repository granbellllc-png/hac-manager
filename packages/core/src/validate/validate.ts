import type { Document, Node } from 'yaml';
import { scanDataDir } from '../data-dir/discovery.js';
import { evaluateExpression } from '../expr/index.js';
import type { EvaluationContext } from '../expr/types.js';
import { mergeConfigs } from '../merge/merge.js';
import { isTagValue, type TagValue } from '../schema/common.js';
import { guestDeploymentSchema } from '../schema/deployment.js';
import { formatIssues, type ConfigIssue } from '../schema/parse.js';
import { resolveSandboxedInclude } from '../tags/include.js';
import { resolveConfigTags } from '../tags/walk.js';
import type { CmdProvider, SecretProvider } from '../tags/types.js';
import { loadYamlDocument, yamlDocumentToJS } from '../yaml/document.js';
import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';
import type {
  ValidateOptions,
  ValidateResult,
  ValidationIssue,
  ValidationStats,
} from './types.js';

export function getLineCol(
  content: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function findNodeByPath(
  doc: Document | undefined,
  path: string,
): Node | undefined {
  if (!doc) return undefined;
  const segments = path
    .split('.')
    .filter(Boolean)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));

  try {
    let curr = doc.getIn(segments, true);
    if (!curr && segments.length > 1) {
      curr = doc.getIn(segments.slice(0, -1), true);
    }
    return (curr as Node) ?? undefined;
  } catch {
    return undefined;
  }
}

function getNodeLineCol(
  content: string,
  node: unknown,
): { line: number; column: number } | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as { range?: [number, number, number] };
  if (Array.isArray(n.range) && typeof n.range[0] === 'number') {
    return getLineCol(content, n.range[0]);
  }
  return undefined;
}

export async function validateDataDir(
  options: ValidateOptions,
): Promise<ValidateResult> {
  const fs: FileSystem = options.fs ?? defaultNodeFileSystem;
  const { dataDir, resolve: shouldResolve = false } = options;

  const issues: ValidationIssue[] = [];

  // Cache loaded file text and Document to avoid reading multiple times
  const fileCache = new Map<
    string,
    { content: string; doc: Document; parsedJS: unknown }
  >();

  async function getOrReadFile(
    fullPath: string,
  ): Promise<
    { content: string; doc: Document; parsedJS: unknown } | undefined
  > {
    const cached = fileCache.get(fullPath);
    if (cached) return cached;
    try {
      const content = await fs.readFile(fullPath, 'utf8');
      const doc = loadYamlDocument(content);
      const parsedJS = yamlDocumentToJS(doc);
      const entry = { content, doc, parsedJS };
      fileCache.set(fullPath, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  // 1. Scan directory structure and validate individual file schemas
  const scanResult = await scanDataDir(dataDir, fs);

  for (const scanIssue of scanResult.issues) {
    if (scanIssue.code === 'invalid_config') {
      const fullPath = `${dataDir.replace(/\/+$/, '')}/${scanIssue.path.replace(/^\/+/, '')}`;
      const fileData = await getOrReadFile(fullPath);

      if (fileData) {
        if (fileData.doc.errors.length > 0) {
          for (const err of fileData.doc.errors) {
            const line = err.linePos?.[0]?.line;
            const column = err.linePos?.[0]?.col;
            issues.push({
              file: scanIssue.path,
              line,
              column,
              message: err.message,
              code: 'yaml_syntax_error',
              severity: 'error',
            });
          }
        }

        if (scanIssue.details && scanIssue.details.length > 0) {
          for (const detail of scanIssue.details) {
            const node = findNodeByPath(fileData.doc, detail.path);
            const lineCol = getNodeLineCol(fileData.content, node);
            issues.push({
              file: scanIssue.path,
              line: lineCol?.line,
              column: lineCol?.column,
              message: detail.message,
              code: detail.code,
              path: detail.path,
              severity: 'error',
            });
          }
        } else if (fileData.doc.errors.length === 0) {
          issues.push({
            file: scanIssue.path,
            message: scanIssue.message,
            code: scanIssue.code,
            severity: 'error',
          });
        }
      } else {
        issues.push({
          file: scanIssue.path,
          message: scanIssue.message,
          code: scanIssue.code,
          severity: 'error',
        });
      }
    } else {
      issues.push({
        file: scanIssue.path,
        message: scanIssue.message,
        code: scanIssue.code,
        severity: 'error',
      });
    }
  }

  // 2. Perform merge validation and tag validation across hosts and guests
  for (const host of scanResult.dataDir.hosts) {
    const hostFileData = await getOrReadFile(host.hostFile);
    const parsedHost = hostFileData?.parsedJS as
      { id?: string; name?: string; index?: number } | undefined;

    let defaultDepData:
      { content: string; doc: Document; parsedJS: unknown } | undefined;
    if (host.defaultDeploymentFile) {
      defaultDepData = await getOrReadFile(host.defaultDeploymentFile);
    }

    for (const guest of host.guests) {
      const guestDepData = await getOrReadFile(guest.deploymentFile);
      if (!guestDepData) continue;
      const activeGuestDepData = guestDepData;

      const defaultSource = defaultDepData
        ? {
            layer: 'default' as const,
            file:
              host.relativeDefaultDeploymentFile ?? 'default-deployment.yaml',
            data: defaultDepData.parsedJS,
            document: defaultDepData.doc,
          }
        : undefined;

      const overrideSource = {
        layer: 'override' as const,
        file: guest.relativeDeploymentFile,
        data: activeGuestDepData.parsedJS,
        document: activeGuestDepData.doc,
      };

      const mergeResult = mergeConfigs(defaultSource, overrideSource);
      const parsedMerged = guestDeploymentSchema.safeParse(mergeResult.merged);

      if (!parsedMerged.success) {
        const zodIssues: ConfigIssue[] = formatIssues(
          parsedMerged.error.issues,
        );
        for (const zi of zodIssues) {
          const prov = mergeResult.provenance.get(zi.path);
          let targetFile = guest.relativeDeploymentFile;
          let lineCol: { line: number; column: number } | undefined;

          if (prov && prov.file) {
            targetFile = prov.file;
            const sourceDoc =
              prov.layer === 'default' ? defaultDepData?.doc : guestDepData.doc;
            const sourceContent =
              prov.layer === 'default'
                ? defaultDepData?.content
                : guestDepData.content;

            if (sourceDoc && sourceContent) {
              const node = findNodeByPath(sourceDoc, zi.path);
              lineCol = getNodeLineCol(sourceContent, node);
            }
          }

          issues.push({
            file: targetFile,
            line: lineCol?.line,
            column: lineCol?.column,
            message: `Merged deployment invalid: ${zi.message}`,
            code: zi.code,
            path: zi.path,
            severity: 'error',
          });
        }
      }

      // 3. Tag checks and resolution on the guest configuration
      const guestContext: EvaluationContext = {
        host: {
          id: host.id,
          name: host.name,
          index: parsedHost?.index ?? 1,
        },
        guest: {
          id: guest.vmid,
          name: guest.name,
          type:
            (guestDepData.parsedJS as { type?: 'lxc' | 'vm' })?.type ?? 'lxc',
        },
        vmid: guest.vmid,
      };

      if (shouldResolve) {
        const res = await resolveConfigTags(mergeResult.merged, {
          dataDir,
          env: options.env,
          secretProvider: options.secretProvider as SecretProvider,
          cmdProvider: options.cmdProvider as CmdProvider,
          evaluationContext: guestContext,
          fs,
        });

        for (const err of res.report.errors) {
          issues.push({
            file: guest.relativeDeploymentFile,
            message: `Tag error in '!${err.tag} ${err.raw}': ${err.error}`,
            code: 'tag_error',
            severity: 'error',
          });
        }
        for (const unres of res.report.unresolved) {
          issues.push({
            file: guest.relativeDeploymentFile,
            message: `Unresolved tag '!${unres.tag} ${unres.raw}': ${unres.reason}`,
            code: 'unresolved_tag',
            severity: 'error',
          });
        }
        for (const locked of res.report.locked) {
          issues.push({
            file: guest.relativeDeploymentFile,
            message: `Locked provider for '!${locked.tag} ${locked.raw}': ${locked.reason}`,
            code: 'locked_tag',
            severity: 'error',
          });
        }
      } else {
        // Offline tag check: validate !expr expressions, sandboxed !include, and tag shapes
        async function checkTagsRecursively(
          val: unknown,
          currentPath: string[],
          currentCtx: EvaluationContext,
        ): Promise<void> {
          if (val === null || val === undefined) return;

          if (isTagValue(val)) {
            const tagVal = val as TagValue;
            if (tagVal.tag === 'expr') {
              try {
                evaluateExpression(tagVal.value, currentCtx);
              } catch (err) {
                const prov = mergeResult.provenance.get(currentPath);
                const targetFile = prov?.file ?? guest.relativeDeploymentFile;
                let lineCol: { line: number; column: number } | undefined;

                const sourceDoc =
                  prov?.layer === 'default'
                    ? defaultDepData?.doc
                    : activeGuestDepData.doc;
                const sourceContent =
                  prov?.layer === 'default'
                    ? defaultDepData?.content
                    : activeGuestDepData.content;
                if (sourceDoc && sourceContent) {
                  const node = findNodeByPath(sourceDoc, currentPath.join('.'));
                  lineCol = getNodeLineCol(sourceContent, node);
                }

                issues.push({
                  file: targetFile,
                  line: lineCol?.line,
                  column: lineCol?.column,
                  message: `Invalid expression '!expr ${tagVal.value}': ${(err as Error).message}`,
                  code: 'invalid_expr',
                  path: currentPath.join('.'),
                  severity: 'error',
                });
              }
            } else if (tagVal.tag === 'include') {
              const incRes = await resolveSandboxedInclude(
                tagVal.value,
                dataDir,
                guest.dir,
                fs,
              );
              if (incRes.status !== 'resolved') {
                const prov = mergeResult.provenance.get(currentPath);
                const targetFile = prov?.file ?? guest.relativeDeploymentFile;
                issues.push({
                  file: targetFile,
                  message: `Invalid include '!include ${tagVal.value}': ${incRes.error}`,
                  code: 'invalid_include',
                  path: currentPath.join('.'),
                  severity: 'error',
                });
              }
            }
            return;
          }

          if (Array.isArray(val)) {
            for (let i = 0; i < val.length; i++) {
              const item = val[i];
              let nextCtx = currentCtx;
              if (
                typeof item === 'object' &&
                item !== null &&
                'index' in item &&
                typeof (item as Record<string, unknown>).index === 'number'
              ) {
                nextCtx = {
                  ...currentCtx,
                  net: {
                    index: (item as Record<string, unknown>).index as number,
                    bridge: (item as Record<string, unknown>).bridge as
                      string | undefined,
                    name: (item as Record<string, unknown>).name as
                      string | undefined,
                  },
                };
              }
              await checkTagsRecursively(
                item,
                [...currentPath, String(i)],
                nextCtx,
              );
            }
            return;
          }

          if (typeof val === 'object') {
            for (const [k, v] of Object.entries(
              val as Record<string, unknown>,
            )) {
              await checkTagsRecursively(v, [...currentPath, k], currentCtx);
            }
          }
        }

        await checkTagsRecursively(mergeResult.merged, [], guestContext);
      }
    }
  }

  const valid = issues.every((i) => i.severity !== 'error');
  const stats: ValidationStats = {
    hosts: scanResult.dataDir.hosts.length,
    guests: scanResult.dataDir.hosts.reduce(
      (acc, h) => acc + h.guests.length,
      0,
    ),
    files: Object.keys(scanResult.dataDir.fileHashes).length,
  };

  return {
    valid,
    issues,
    stats,
  };
}
