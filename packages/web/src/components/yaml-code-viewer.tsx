import { useEffect, useRef } from 'react';
import { yaml } from '@codemirror/lang-yaml';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';

export function YamlCodeViewer({
  value,
  label = 'YAML configuration',
}: {
  readonly value: string;
  readonly label?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = new EditorView({
      parent: containerRef.current!,
      doc: value,
      extensions: [
        yaml(),
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorView.theme({
          '&': {
            backgroundColor: 'var(--muted)',
            color: 'var(--foreground)',
            fontSize: '0.8125rem',
          },
          '.cm-scroller': {
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            maxHeight: '30rem',
            overflow: 'auto',
          },
          '.cm-gutters': {
            backgroundColor: 'color-mix(in oklab, var(--muted) 88%, black)',
            borderRight: '1px solid var(--border)',
            color: 'var(--muted-foreground)',
          },
          '.cm-content': { padding: '0.75rem 0' },
          '.cm-line': { padding: '0 0.75rem' },
        }),
      ],
    });

    return () => {
      view.destroy();
    };
  }, [label, value]);

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-md border border-border"
      data-testid="yaml-code-viewer"
    />
  );
}
