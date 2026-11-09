import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { apiClient } from '../api/client';
import { Button } from './ui/button';
import {
  YamlCodeEditor,
  type EditorValidationResult,
} from './yaml-code-editor';
import { YamlDiff } from './yaml-diff';

export interface GuestYamlSnapshot {
  readonly relativePath: string;
  readonly rawYaml: string;
  readonly hash: string;
  readonly config?: Record<string, unknown> | undefined;
  readonly issues: readonly {
    readonly path: string;
    readonly message: string;
    readonly code: string;
  }[];
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return fallback;
}

export function GuestYamlEditor({
  hostId,
  vmid,
  guestName,
  role,
  snapshot,
  onSaved,
  onCancel,
}: {
  readonly hostId: string;
  readonly vmid: number;
  readonly guestName: string;
  readonly role: string;
  readonly snapshot: GuestYamlSnapshot;
  readonly onSaved: (snapshot: GuestYamlSnapshot) => void;
  readonly onCancel: () => void;
}) {
  const [schema, setSchema] = useState<Readonly<
    Record<string, unknown>
  > | null>(null);
  const [draft, setDraft] = useState(snapshot.rawYaml);
  const [validation, setValidation] = useState<EditorValidationResult | null>(
    null,
  );
  const [reviewing, setReviewing] = useState(false);
  const [loadingSchema, setLoadingSchema] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    const loadSchema = async () => {
      setLoadingSchema(true);
      try {
        const result = await apiClient.GET('/api/config/schema/deployment');
        if (!active) return;
        if (!result.data) {
          setError('Unable to load deployment schema.');
          return;
        }
        setSchema(result.data.schema);
      } catch (loadError) {
        if (active) {
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
        }
      } finally {
        if (active) setLoadingSchema(false);
      }
    };
    void loadSchema();
    return () => {
      active = false;
    };
  }, []);

  const validateDraft = useCallback(
    async (rawYaml: string): Promise<EditorValidationResult> => {
      const result = await apiClient.POST(
        '/api/config/guests/{hostId}/{vmid}/validate',
        {
          params: { path: { hostId, vmid } },
          body: { rawYaml },
        },
      );
      if (result.error || !result.data) {
        throw new Error(
          errorMessage(result.error, 'Unable to validate deployment YAML.'),
        );
      }
      return result.data;
    },
    [hostId, vmid],
  );

  const reviewChanges = async () => {
    setError(null);
    setSaved(false);
    if (draft === snapshot.rawYaml) {
      setError('Make a change before opening the diff preview.');
      return;
    }
    try {
      const result = await validateDraft(draft);
      setValidation(result);
      if (!result.valid) {
        setError('Fix the validation issues before reviewing this change.');
        return;
      }
      if (role !== 'admin' && result.requiresAdmin) {
        setReviewing(true);
        return;
      }
      const preflight = await apiClient.PUT(
        '/api/config/guests/{hostId}/{vmid}',
        {
          params: { path: { hostId, vmid } },
          body: {
            rawYaml: draft,
            expectedHash: snapshot.hash,
            dryRun: true,
          },
        },
      );
      if (preflight.error || !preflight.data) {
        setError(
          errorMessage(
            preflight.error,
            'Unable to preflight the guarded YAML save.',
          ),
        );
        return;
      }
      setReviewing(true);
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : String(reviewError),
      );
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await apiClient.PUT('/api/config/guests/{hostId}/{vmid}', {
        params: { path: { hostId, vmid } },
        body: { rawYaml: draft, expectedHash: snapshot.hash },
      });
      if (result.error || !result.data) {
        setError(errorMessage(result.error, 'Unable to save deployment YAML.'));
        return;
      }
      const nextSnapshot: GuestYamlSnapshot = {
        relativePath: snapshot.relativePath,
        rawYaml: result.data.rawYaml,
        hash: result.data.hash,
        config: result.data.config,
        issues: result.data.issues,
      };
      setDraft(nextSnapshot.rawYaml);
      setReviewing(false);
      setValidation({
        valid: true,
        issues: [],
        adminOnly: [],
        requiresAdmin: false,
      });
      setSaved(true);
      onSaved(nextSnapshot);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  };

  const blockedForRole = role !== 'admin' && Boolean(validation?.requiresAdmin);

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Edit deployment YAML</h2>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {snapshot.relativePath}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel editing
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300"
        >
          {error}
        </div>
      )}
      {saved && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <CheckCircle2 aria-hidden className="h-4 w-4" />
          YAML saved with its comments intact.
        </div>
      )}
      {validation?.requiresAdmin && (
        <div
          role="alert"
          className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
        >
          <ShieldAlert
            aria-hidden
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
          />
          <span>
            Administrator approval is required for:{' '}
            {validation.adminOnly.join(', ')}.
          </span>
        </div>
      )}
      {validation && validation.issues.length > 0 && (
        <div className="rounded-md border border-amber-500/30 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle aria-hidden className="h-4 w-4" />
            Validation issues
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {validation.issues.map((issue) => (
              <li key={`${issue.path}:${issue.code}:${issue.message}`}>
                {issue.path || 'document'}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {loadingSchema ? (
        <div className="h-96 animate-pulse rounded-md bg-muted" />
      ) : schema ? (
        <YamlCodeEditor
          value={draft}
          label={`${guestName} editable deployment YAML`}
          schema={schema}
          validate={validateDraft}
          onChange={(value) => {
            setDraft(value);
            setReviewing(false);
            setSaved(false);
          }}
          onValidation={setValidation}
        />
      ) : null}

      {reviewing && (
        <div className="space-y-3" data-testid="yaml-review">
          <div>
            <h3 className="font-semibold">Diff preview</h3>
            <p className="text-sm text-muted-foreground">
              Review every line before saving through the external-edit guard.
            </p>
          </div>
          <YamlDiff before={snapshot.rawYaml} after={draft} />
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
        {reviewing && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReviewing(false)}
          >
            Back to editor
          </Button>
        )}
        <Button
          variant={reviewing ? 'default' : 'outline'}
          size="sm"
          disabled={loadingSchema || saving || blockedForRole}
          onClick={() => {
            if (reviewing) void save();
            else void reviewChanges();
          }}
        >
          {saving ? 'Saving…' : reviewing ? 'Save YAML' : 'Review changes'}
        </Button>
      </div>
    </section>
  );
}
