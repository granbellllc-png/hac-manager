import { Secret } from '../tags/secret.js';
import { globalSecretRedactor, SecretRedactor } from './redactor.js';

const SENSITIVE_KEY_PATTERN =
  /(password|token|secret|private_key|token_secret|api_key|credential|authorization|cookie|session_id)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function sanitizeValue(
  val: unknown,
  redactor: SecretRedactor = globalSecretRedactor,
): unknown {
  if (val === null || val === undefined) {
    return val;
  }

  if (val instanceof Secret) {
    return '***';
  }

  if (typeof val === 'string') {
    return redactor.redact(val);
  }

  if (Array.isArray(val)) {
    return val.map((item) => sanitizeValue(item, redactor));
  }

  if (typeof val === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        res[k] = '***';
      } else {
        res[k] = sanitizeValue(v, redactor);
      }
    }
    return res;
  }

  return val;
}

export function sanitizeAuditPayload<T = unknown>(
  payload: T,
  redactor: SecretRedactor = globalSecretRedactor,
): T {
  return sanitizeValue(payload, redactor) as T;
}

export function sanitizeDiff<T = unknown>(
  diff: T,
  redactor: SecretRedactor = globalSecretRedactor,
): T {
  return sanitizeValue(diff, redactor) as T;
}
