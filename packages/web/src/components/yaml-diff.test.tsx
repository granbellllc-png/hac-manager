import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildLineDiff, YamlDiff } from './yaml-diff';

describe('YAML line diff', () => {
  it('produces context, removed, and added lines and renders their markers', () => {
    expect(buildLineDiff('a\nb\nc', 'a\nchanged\nc\nd')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'changed' },
      { kind: 'context', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);

    render(<YamlDiff before={'cpu: 1\nname: x'} after={'cpu: 2\nname: x'} />);
    const diff = screen.getByTestId('yaml-diff');
    expect(diff).toHaveTextContent('−cpu: 1');
    expect(diff).toHaveTextContent('+cpu: 2');
    expect(diff).toHaveTextContent('name: x');
  });

  it('handles remaining removals, blank lines, and bounded large diffs', () => {
    expect(buildLineDiff('a\nb', 'a')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'removed', text: 'b' },
    ]);
    const largeBefore = Array.from(
      { length: 400 },
      (_, index) => `a${index}`,
    ).join('\n');
    const largeAfter = Array.from(
      { length: 400 },
      (_, index) => `b${index}`,
    ).join('\n');
    const large = buildLineDiff(largeBefore, largeAfter);
    expect(large).toHaveLength(800);
    expect(large[0]?.kind).toBe('removed');
    expect(large.at(-1)?.kind).toBe('added');

    render(<YamlDiff before="" after="" />);
    expect(screen.getByTestId('yaml-diff').children).toHaveLength(1);
  });
});
