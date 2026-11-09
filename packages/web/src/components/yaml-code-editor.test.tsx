import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import {
  createRootCompletionSource,
  schemaRootCompletions,
  validationDiagnosticRange,
  YamlCodeEditor,
  type EditorValidationResult,
} from './yaml-code-editor';

const schema = {
  oneOf: [
    {
      properties: {
        name: { description: 'Guest name' },
        type: { description: 'Guest type' },
      },
    },
    {
      properties: {
        name: { description: 'Guest name' },
        ram: {},
      },
    },
    null,
  ],
};

describe('YamlCodeEditor', () => {
  it('derives unique root completions from JSON Schema branches', () => {
    expect(schemaRootCompletions(schema)).toEqual([
      expect.objectContaining({ label: 'name', detail: 'Guest name' }),
      expect.objectContaining({ label: 'ram', apply: 'ram: ' }),
      expect.objectContaining({ label: 'type', detail: 'Guest type' }),
    ]);
    expect(schemaRootCompletions({})).toEqual([]);
  });

  it('completes unused root keys and maps validation paths to document ranges', () => {
    const source = createRootCompletionSource(schema);
    const state = EditorState.create({ doc: 'name: guest\nr' });
    const result = source(new CompletionContext(state, state.doc.length, true));
    expect(result?.options.map((option) => option.label)).toEqual([
      'ram',
      'type',
    ]);
    expect(
      source(
        new CompletionContext(EditorState.create({ doc: '  nested' }), 8, true),
      ),
    ).toBeNull();
    expect(
      source(new CompletionContext(EditorState.create({ doc: '' }), 0, false)),
    ).toBeNull();
    expect(
      source(new CompletionContext(EditorState.create({ doc: '' }), 0, true))
        ?.options.length,
    ).toBe(3);

    const document = EditorState.create({ doc: 'name: guest\ncpu: 2' }).doc;
    expect(
      validationDiagnosticRange(document, {
        path: 'cpu',
        code: 'invalid',
        message: 'bad cpu',
      }),
    ).toEqual({ from: 12, to: 18 });
    expect(
      validationDiagnosticRange(document, {
        path: 'missing',
        code: 'invalid',
        message: 'missing',
      }),
    ).toEqual({ from: 0, to: 1 });
    expect(
      validationDiagnosticRange(EditorState.create({ doc: '' }).doc, {
        path: '',
        code: 'invalid',
        message: 'document',
      }),
    ).toEqual({ from: 0, to: 0 });
  });

  it('renders an editable CodeMirror view, validates it, and syncs external changes', async () => {
    const valid: EditorValidationResult = {
      valid: false,
      issues: [
        { path: 'name', code: 'invalid', message: 'Bad name' },
        { path: 'missing', code: 'invalid', message: 'Missing field' },
      ],
      adminOnly: [],
      requiresAdmin: false,
    };
    const validate = vi.fn().mockResolvedValue(valid);
    const onChange = vi.fn();
    const onValidation = vi.fn();
    const { rerender, unmount } = render(
      <YamlCodeEditor
        value={'name: guest\n'}
        label="Editable deployment YAML"
        schema={schema}
        validate={validate}
        onChange={onChange}
        onValidation={onValidation}
      />,
    );

    expect(screen.getByLabelText('Editable deployment YAML')).toHaveAttribute(
      'contenteditable',
      'true',
    );
    await waitFor(() => expect(validate).toHaveBeenCalled());
    expect(onValidation).toHaveBeenCalledWith(valid);

    rerender(
      <YamlCodeEditor
        value={'name: guest\nram: 2048\n'}
        label="Editable deployment YAML"
        schema={schema}
        validate={validate}
        onChange={onChange}
        onValidation={onValidation}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('yaml-code-editor')).toHaveTextContent(
        'ram: 2048',
      ),
    );
    expect(onChange).toHaveBeenCalledWith('name: guest\nram: 2048\n');
    unmount();
  });

  it.each([new Error('validation unavailable'), 'validation unavailable'])(
    'surfaces validation request failures as editor issues',
    async (failure) => {
      const onValidation = vi.fn();
      render(
        <YamlCodeEditor
          value={'name: guest\n'}
          label="Failing YAML editor"
          schema={schema}
          validate={async () => {
            throw failure;
          }}
          onChange={() => undefined}
          onValidation={onValidation}
        />,
      );

      await waitFor(() =>
        expect(onValidation).toHaveBeenCalledWith(
          expect.objectContaining({
            valid: false,
            issues: [
              expect.objectContaining({ message: 'validation unavailable' }),
            ],
          }),
        ),
      );
    },
  );
});
