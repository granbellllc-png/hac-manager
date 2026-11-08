import { evaluateExpression } from '../expr/index.js';
import type { TagValue } from '../schema/common.js';
import { resolveSandboxedInclude } from './include.js';
import { Secret } from './secret.js';
import type { ResolutionContext, ResolvedTagResult } from './types.js';

export async function resolveTag(
  tagValue: TagValue,
  context: ResolutionContext,
): Promise<ResolvedTagResult> {
  const { tag, value } = tagValue;

  switch (tag) {
    case 'env': {
      const envDict = context.env ?? process.env;
      const envVal = envDict[value];
      if (envVal !== undefined) {
        return {
          status: 'resolved',
          tag: 'env',
          raw: value,
          value: envVal,
        };
      }
      return {
        status: 'unresolved',
        tag: 'env',
        raw: value,
        reason: `Environment variable '${value}' is not defined`,
      };
    }

    case 'secret': {
      if (!context.secretProvider) {
        return {
          status: 'unresolved',
          tag: 'secret',
          raw: value,
          reason: `No secret provider configured to resolve '!secret ${value}'`,
        };
      }

      try {
        const res = await context.secretProvider.resolveSecret(value);
        if (res.status === 'found') {
          return {
            status: 'resolved',
            tag: 'secret',
            raw: value,
            value: new Secret(res.value),
          };
        }
        if (res.status === 'locked') {
          return {
            status: 'locked',
            tag: 'secret',
            raw: value,
            reason: res.reason,
          };
        }
        if (res.status === 'not_found') {
          return {
            status: 'unresolved',
            tag: 'secret',
            raw: value,
            reason:
              res.reason ?? `Secret '${value}' not found in secret provider`,
          };
        }
        return {
          status: 'error',
          tag: 'secret',
          raw: value,
          error: res.error,
        };
      } catch (err) {
        return {
          status: 'error',
          tag: 'secret',
          raw: value,
          error: (err as Error).message,
        };
      }
    }

    case 'cmd': {
      if (!context.cmdProvider) {
        return {
          status: 'unresolved',
          tag: 'cmd',
          raw: value,
          reason: `No command provider configured to resolve '!cmd ${value}'`,
        };
      }

      try {
        const res = await context.cmdProvider.resolveCmd(value);
        if (res.status === 'success') {
          return {
            status: 'resolved',
            tag: 'cmd',
            raw: value,
            value: new Secret(res.output),
          };
        }
        if (res.status === 'locked') {
          return {
            status: 'locked',
            tag: 'cmd',
            raw: value,
            reason: res.reason,
          };
        }
        if (res.status === 'not_allowed') {
          return {
            status: 'error',
            tag: 'cmd',
            raw: value,
            error: `Command '${value}' is not allowed by admin allowlist: ${res.reason}`,
          };
        }
        return {
          status: 'error',
          tag: 'cmd',
          raw: value,
          error: res.error,
        };
      } catch (err) {
        return {
          status: 'error',
          tag: 'cmd',
          raw: value,
          error: (err as Error).message,
        };
      }
    }

    case 'expr': {
      try {
        const evaluated = evaluateExpression(value, context.evaluationContext);
        return {
          status: 'resolved',
          tag: 'expr',
          raw: value,
          value: evaluated,
        };
      } catch (err) {
        return {
          status: 'error',
          tag: 'expr',
          raw: value,
          error: (err as Error).message,
        };
      }
    }

    case 'include': {
      return resolveSandboxedInclude(
        value,
        context.dataDir,
        context.currentFileDir,
        context.fs,
        context.includedPaths,
      );
    }
  }
}
