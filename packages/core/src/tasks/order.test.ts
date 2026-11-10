import { describe, expect, it } from 'vitest';
import type { TagValue } from '../schema/common.js';
import {
  compareTaskFileNames,
  isTaskTag,
  orderTaskFiles,
  taskFileOrderKey,
  taskTargetsMatchHost,
} from './order.js';

describe('taskTargetsMatchHost', () => {
  const host = {
    id: 'pve-01',
    name: 'Primary',
    groups: ['servers', 'prod'],
    tags: ['fast', 'ssd'],
  };

  it('applies an untargeted file to every host', () => {
    expect(taskTargetsMatchHost(undefined, { id: 'any' })).toBe(true);
    expect(taskTargetsMatchHost({}, { id: 'any' })).toBe(true);
    expect(taskTargetsMatchHost({ groups: [], tags: [] }, { id: 'any' })).toBe(
      true,
    );
    expect(
      taskTargetsMatchHost({ groups: [''], tags: [] }, { id: 'any' }),
    ).toBe(true);
  });

  it('matches a host group or host tag', () => {
    expect(taskTargetsMatchHost({ groups: ['prod'] }, host)).toBe(true);
    expect(taskTargetsMatchHost({ groups: ['other', 'servers'] }, host)).toBe(
      true,
    );
    expect(taskTargetsMatchHost({ tags: ['ssd'] }, host)).toBe(true);
    expect(
      taskTargetsMatchHost({ groups: ['other'], tags: ['ssd'] }, host),
    ).toBe(true);
    expect(
      taskTargetsMatchHost({ groups: ['other'], tags: ['slow'] }, host),
    ).toBe(false);
  });

  it('does not match hosts without groups or tags', () => {
    expect(taskTargetsMatchHost({ groups: ['prod'] }, { id: 'bare' })).toBe(
      false,
    );
    expect(taskTargetsMatchHost({ tags: ['ssd'] }, { id: 'bare' })).toBe(false);
  });
});

describe('task file ordering', () => {
  it('extracts the numeric prefix', () => {
    expect(taskFileOrderKey('010-setup.yaml')).toEqual({
      numeric: true,
      value: 10,
      name: '010-setup.yaml',
    });
    expect(taskFileOrderKey('setup.yaml')).toEqual({
      numeric: false,
      value: 0,
      name: 'setup.yaml',
    });
  });

  it('orders numeric prefixes numerically and files without one last', () => {
    const files = [
      { name: 'update.yaml' },
      { name: '100-last.yaml' },
      { name: '20-second.yaml' },
      { name: '001-first.yaml' },
      { name: 'a-also-last.yaml' },
    ];
    expect(orderTaskFiles(files).map((file) => file.name)).toEqual([
      '001-first.yaml',
      '20-second.yaml',
      '100-last.yaml',
      'a-also-last.yaml',
      'update.yaml',
    ]);
    expect(files[0]?.name).toBe('update.yaml');
  });

  it('breaks numeric ties and non-numeric names lexicographically', () => {
    expect(compareTaskFileNames('10-b.yaml', '10-a.yaml')).toBeGreaterThan(0);
    expect(compareTaskFileNames('a.yaml', 'b.yaml')).toBeLessThan(0);
    expect(compareTaskFileNames('1-a.yaml', 'a.yaml')).toBeLessThan(0);
    expect(compareTaskFileNames('2-a.yaml', 'a.yaml')).toBeLessThan(0);
    expect(compareTaskFileNames('same.yaml', 'same.yaml')).toBe(0);
  });
});

describe('isTaskTag', () => {
  it('recognises tag objects only', () => {
    const tag: TagValue = { tag: 'env', value: 'HOME' };
    expect(isTaskTag(tag)).toBe(true);
    expect(isTaskTag('literal')).toBe(false);
    expect(isTaskTag(null)).toBe(false);
    expect(isTaskTag({ tag: 'env' })).toBe(false);
  });
});
