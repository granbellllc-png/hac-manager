import type {
  DatabaseRepositories,
  CreateAuditInput,
} from '../db/repositories/types.js';
import type { AuditLogRow } from '../db/schema.js';

/**
 * Appends an audit log entry.
 * Inputs (diff and metadata) are automatically sanitized to prevent secret leaks.
 */
export async function recordAudit(
  repos: DatabaseRepositories,
  input: CreateAuditInput,
): Promise<AuditLogRow> {
  return repos.auditLogs.append(input);
}
