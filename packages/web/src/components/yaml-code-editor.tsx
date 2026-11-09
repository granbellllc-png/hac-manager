import { useEffect, useRef } from 'react';
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import type { Text } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view';

export interface EditorValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export interface EditorValidationResult {
  readonly valid: boolean;
  readonly issues: readonly EditorValidationIssue[];
  readonly adminOnly: readonly string[];
  readonly requiresAdmin: boolean;
}

interface SchemaNode {
  readonly oneOf?: readonly unknown[];
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly description?: string;
}

function asSchemaNode(value: unknown): SchemaNode | undefined {
  return typeof value === 'object' && value !== null
    ? (value as SchemaNode)
    : undefined;
}

export function schemaRootCompletions(
  schema: Readonly<Record<string, unknown>>,
): readonly Completion[] {
  const options = new Map<string, Completion>();
  const root = asSchemaNode(schema);
  const branches = root?.oneOf ?? [schema];

  for (const branch of branches) {
    const properties = asSchemaNode(branch)?.properties;
    if (!properties) continue;
    for (const [name, rawProperty] of Object.entries(properties)) {
      const property = asSchemaNode(rawProperty);
      options.set(name, {
        label: name,
        type: 'property',
        ...(property?.description ? { detail: property.description } : {}),
        apply: `${name}: `,
      });
    }
  }

  return [...options.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

export function createRootCompletionSource(
  schema: Readonly<Record<string, unknown>>,
): (context: CompletionContext) => CompletionResult | null {
  const options = schemaRootCompletions(schema);
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const beforeCursor = line.text.slice(0, context.pos - line.from);
    if (/^\s+/.test(beforeCursor)) return null;
    const word = context.matchBefore(/[A-Za-z_][\w-]*/);
    if (!word && !context.explicit) return null;

    const existing = new Set<string>();
    for (
      let lineNumber = 1;
      lineNumber <= context.state.doc.lines;
      lineNumber++
    ) {
      const text = context.state.doc.line(lineNumber).text;
      const match = /^([A-Za-z_][\w-]*):/.exec(text);
      if (match?.[1]) existing.add(match[1]);
    }

    return {
      from: word?.from ?? context.pos,
      options: options.filter((option) => !existing.has(option.label)),
    };
  };
}

export function validationDiagnosticRange(
  document: Text,
  issue: EditorValidationIssue,
): { readonly from: number; readonly to: number } {
  const rootKey = issue.path.split('.')[0];
  if (rootKey) {
    for (let lineNumber = 1; lineNumber <= document.lines; lineNumber++) {
      const line = document.line(lineNumber);
      if (line.text.startsWith(`${rootKey}:`)) {
        return { from: line.from, to: Math.max(line.from + 1, line.to) };
      }
    }
  }
  return { from: 0, to: Math.min(1, document.length) };
}

export function YamlCodeEditor({
  value,
  label,
  schema,
  validate,
  onChange,
  onValidation,
}: {
  readonly value: string;
  readonly label: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly validate: (value: string) => Promise<EditorValidationResult>;
  readonly onChange: (value: string) => void;
  readonly onValidation: (result: EditorValidationResult) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onValidationRef = useRef(onValidation);

  useEffect(() => {
    onChangeRef.current = onChange;
    onValidationRef.current = onValidation;
  }, [onChange, onValidation]);

  useEffect(() => {
    const validateExtension = linter(
      async (view): Promise<readonly Diagnostic[]> => {
        try {
          const result = await validate(view.state.doc.toString());
          onValidationRef.current(result);
          return result.issues.map((issue) => ({
            ...validationDiagnosticRange(view.state.doc, issue),
            severity: 'error' as const,
            message: `${issue.path ? `${issue.path}: ` : ''}${issue.message}`,
          }));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const result: EditorValidationResult = {
            valid: false,
            issues: [{ path: '', code: 'validation_request', message }],
            adminOnly: [],
            requiresAdmin: false,
          };
          onValidationRef.current(result);
          return [
            {
              from: 0,
              to: Math.min(1, view.state.doc.length),
              severity: 'error',
              message,
            },
          ];
        }
      },
      { delay: 400 },
    );

    const view = new EditorView({
      parent: containerRef.current!,
      doc: value,
      extensions: [
        yaml(),
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        autocompletion({ override: [createRootCompletionSource(schema)] }),
        validateExtension,
        lintGutter(),
        EditorView.lineWrapping,
        placeholder('Edit deployment YAML…'),
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          '&': {
            minHeight: '22rem',
            backgroundColor: 'var(--background)',
            color: 'var(--foreground)',
            fontSize: '0.8125rem',
          },
          '&.cm-focused': { outline: '2px solid var(--primary)' },
          '.cm-scroller': {
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            minHeight: '22rem',
            maxHeight: '38rem',
            overflow: 'auto',
          },
          '.cm-gutters': {
            backgroundColor: 'var(--muted)',
            borderRight: '1px solid var(--border)',
            color: 'var(--muted-foreground)',
          },
          '.cm-content': { padding: '0.75rem 0' },
          '.cm-line': { padding: '0 0.75rem' },
        }),
      ],
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [label, schema, validate]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-md border border-border"
      data-testid="yaml-code-editor"
    />
  );
}
