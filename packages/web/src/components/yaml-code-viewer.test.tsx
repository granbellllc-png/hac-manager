import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { YamlCodeViewer } from './yaml-code-viewer';

describe('YamlCodeViewer', () => {
  it('renders exact YAML in a labelled read-only CodeMirror view and updates it', () => {
    const { rerender, unmount } = render(
      <YamlCodeViewer
        value={'# comment\ncpu: !expr "host.index + 1"\n'}
        label="Guest deployment YAML"
      />,
    );

    const editor = screen.getByLabelText('Guest deployment YAML');
    expect(editor).toHaveAttribute('contenteditable', 'false');
    expect(screen.getByTestId('yaml-code-viewer')).toHaveTextContent(
      '# comment',
    );
    expect(screen.getByTestId('yaml-code-viewer')).toHaveTextContent(
      'host.index + 1',
    );

    rerender(<YamlCodeViewer value={'ram: 2048\n'} />);
    expect(screen.getByLabelText('YAML configuration')).toBeInTheDocument();
    expect(screen.getByTestId('yaml-code-viewer')).toHaveTextContent(
      'ram: 2048',
    );

    unmount();
  });
});
