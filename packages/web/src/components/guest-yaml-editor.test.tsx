import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuestYamlEditor, type GuestYamlSnapshot } from './guest-yaml-editor';

vi.mock('./yaml-code-editor', () => ({
  YamlCodeEditor: ({
    value,
    label,
    onChange,
  }: {
    value: string;
    label: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const snapshot: GuestYamlSnapshot = {
  relativePath: 'hosts/fixture-host/112-example/deployment.yaml',
  rawYaml:
    '# keep comment\nschema_version: 1\nid: 112\nname: example\ntype: lxc\ncpu: 1\n',
  hash: 'a'.repeat(64),
  config: { id: 112, name: 'example', type: 'lxc', cpu: 1 },
  issues: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function installApi({
  validation = {
    valid: true,
    issues: [],
    adminOnly: [],
    requiresAdmin: false,
  },
  schemaFailure,
  validationFailure,
  preflightFailure,
  saveFailure,
}: {
  readonly validation?: {
    readonly valid: boolean;
    readonly issues: readonly {
      readonly path: string;
      readonly message: string;
      readonly code: string;
    }[];
    readonly adminOnly: readonly string[];
    readonly requiresAdmin: boolean;
  };
  readonly schemaFailure?: 'http' | 'network';
  readonly validationFailure?: 'http' | 'network' | 'non-error';
  readonly preflightFailure?: 'http' | 'network';
  readonly saveFailure?: 'http' | 'network' | 'non-error';
} = {}) {
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    if (path === '/api/config/schema/deployment') {
      if (schemaFailure === 'http') return Response.json({}, { status: 500 });
      if (schemaFailure === 'network') throw new Error('schema offline');
      return Response.json({
        schema: { oneOf: [{ properties: { cpu: {} } }] },
      });
    }
    if (path.endsWith('/validate')) {
      if (validationFailure === 'http')
        return Response.json(
          { message: 'validation rejected' },
          { status: 400 },
        );
      if (validationFailure === 'network') throw new Error('validator offline');
      if (validationFailure === 'non-error') throw 'validator offline';
      return Response.json(validation);
    }
    if (request.method === 'PUT') {
      const body = JSON.parse(await request.text()) as {
        rawYaml: string;
        expectedHash: string;
        dryRun?: boolean;
      };
      if (body.dryRun) {
        if (preflightFailure === 'http')
          return Response.json({}, { status: 409 });
        if (preflightFailure === 'network')
          throw new Error('preflight offline');
        return Response.json({
          success: true,
          dryRun: true,
          rawYaml: body.rawYaml,
          hash: body.expectedHash,
          config: { id: 112, name: 'example', type: 'lxc', cpu: 2 },
          issues: [],
        });
      }
      if (saveFailure === 'http')
        return Response.json(
          { message: 'The YAML file changed outside this editor.' },
          { status: 409 },
        );
      if (saveFailure === 'network') throw new Error('save offline');
      if (saveFailure === 'non-error') throw 'save offline';
      return Response.json({
        success: true,
        dryRun: false,
        rawYaml: body.rawYaml,
        hash: 'b'.repeat(64),
        config: { id: 112, name: 'example', type: 'lxc', cpu: 2 },
        issues: [],
      });
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

function renderEditor(
  options: {
    readonly role?: string;
    readonly onSaved?: (value: GuestYamlSnapshot) => void;
    readonly onCancel?: () => void;
  } = {},
) {
  return render(
    <GuestYamlEditor
      hostId="fixture-host"
      vmid={112}
      guestName="example"
      role={options.role ?? 'admin'}
      snapshot={snapshot}
      onSaved={options.onSaved ?? (() => undefined)}
      onCancel={options.onCancel ?? (() => undefined)}
    />,
  );
}

describe('GuestYamlEditor', () => {
  it('loads schema, previews the diff, saves guarded YAML, and cancels editing', async () => {
    const fetchFn = installApi();
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    renderEditor({ onSaved, onCancel });

    const editor = await screen.findByLabelText(
      'example editable deployment YAML',
    );
    await user.clear(editor);
    await user.type(editor, snapshot.rawYaml.replace('cpu: 1', 'cpu: 2'));
    await user.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(await screen.findByText('Diff preview')).toBeVisible();
    expect(screen.getByTestId('yaml-diff')).toHaveTextContent('cpu: 2');
    await user.click(screen.getByRole('button', { name: 'Back to editor' }));
    expect(screen.queryByText('Diff preview')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Review changes' }));
    await user.click(screen.getByRole('button', { name: 'Save YAML' }));
    expect(
      await screen.findByText('YAML saved with its comments intact.'),
    ).toBeVisible();
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ hash: 'b'.repeat(64) }),
    );
    expect(
      fetchFn.mock.calls.some(
        ([request]) => (request as Request).method === 'PUT',
      ),
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Cancel editing' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('requires changes and valid YAML before showing the preview', async () => {
    installApi({
      validation: {
        valid: false,
        issues: [{ path: 'cpu', code: 'invalid', message: 'Expected number' }],
        adminOnly: [],
        requiresAdmin: false,
      },
    });
    const user = userEvent.setup();
    renderEditor();
    const editor = await screen.findByLabelText(
      'example editable deployment YAML',
    );

    await user.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(
      await screen.findByText('Make a change before opening the diff preview.'),
    ).toBeVisible();
    await user.type(editor, 'invalid');
    await user.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(
      await screen.findByText(
        'Fix the validation issues before reviewing this change.',
      ),
    ).toBeVisible();
    expect(screen.getByText(/Expected number/)).toBeVisible();
  });

  it('warns operators and blocks saving admin-only execution surfaces', async () => {
    installApi({
      validation: {
        valid: true,
        issues: [],
        adminOnly: ['cmd', 'include'],
        requiresAdmin: true,
      },
    });
    const user = userEvent.setup();
    renderEditor({ role: 'operator' });
    const editor = await screen.findByLabelText(
      'example editable deployment YAML',
    );
    await user.type(editor, '!cmd vault');
    await user.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(await screen.findByText(/Administrator approval/)).toHaveTextContent(
      'cmd, include',
    );
    expect(screen.getByRole('button', { name: 'Save YAML' })).toBeDisabled();
  });

  it.each(['http', 'network', 'non-error'] as const)(
    'reports %s validation request failures',
    async (validationFailure) => {
      installApi({ validationFailure });
      const user = userEvent.setup();
      renderEditor();
      const editor = await screen.findByLabelText(
        'example editable deployment YAML',
      );
      await user.type(editor, 'changed');
      await user.click(screen.getByRole('button', { name: 'Review changes' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        validationFailure === 'http'
          ? 'validation rejected'
          : 'validator offline',
      );
    },
  );

  it.each(['http', 'network'] as const)(
    'reports %s dry-run preflight failures',
    async (preflightFailure) => {
      installApi({ preflightFailure });
      const user = userEvent.setup();
      renderEditor();
      const editor = await screen.findByLabelText(
        'example editable deployment YAML',
      );
      await user.type(editor, 'changed');
      await user.click(screen.getByRole('button', { name: 'Review changes' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        preflightFailure === 'http'
          ? 'Unable to preflight the guarded YAML save.'
          : 'preflight offline',
      );
    },
  );

  it.each(['http', 'network', 'non-error'] as const)(
    'reports %s save failures',
    async (saveFailure) => {
      installApi({ saveFailure });
      const user = userEvent.setup();
      renderEditor();
      const editor = await screen.findByLabelText(
        'example editable deployment YAML',
      );
      await user.type(editor, 'changed');
      await user.click(screen.getByRole('button', { name: 'Review changes' }));
      await screen.findByText('Diff preview');
      await user.click(screen.getByRole('button', { name: 'Save YAML' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        saveFailure === 'http' ? 'changed outside this editor' : 'save offline',
      );
    },
  );

  it.each(['http', 'network'] as const)(
    'reports %s schema loading failures',
    async (schemaFailure) => {
      installApi({ schemaFailure });
      renderEditor();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        schemaFailure === 'http'
          ? 'Unable to load deployment schema.'
          : 'schema offline',
      );
      expect(
        screen.queryByLabelText('example editable deployment YAML'),
      ).toBeNull();
    },
  );
});
