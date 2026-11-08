import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Scalar } from 'yaml';
import { isTagValue } from '../schema/common.js';
import {
  appendToList,
  createTagScalar,
  dumpYamlDocument,
  getYamlNode,
  insertKey,
  loadYamlDocument,
  normalizeYamlPath,
  readYamlFile,
  removeFromList,
  removeKey,
  setScalar,
  wrapTaggedValue,
  writeYamlFile,
  yamlDocumentToJS,
} from './index.js';

const root = resolve(import.meta.dirname, '../../../..');
const exampleData = join(root, 'examples/data');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (
      entry.endsWith('.yaml') ||
      entry.endsWith('.yml') ||
      entry.endsWith('.example')
    ) {
      yield full;
    }
  }
}

describe('YAML Round-trip byte preservation', () => {
  const exampleFiles = [...walk(exampleData)].map((path) =>
    path.slice(exampleData.length + 1).replaceAll('\\', '/'),
  );

  it.each(exampleFiles)('round-trips %s byte-identically', (relative) => {
    const raw = readFileSync(join(exampleData, relative), 'utf8');
    const doc = loadYamlDocument(raw);
    const dumped = dumpYamlDocument(doc);
    expect(dumped).toBe(raw);
  });
});

describe('Scalar mutation and comment preservation', () => {
  it('changing ram: 2048 to 4096 keeps trailing comments and tags', () => {
    const text = `# VM configuration
schema_version: 1
cpu: 2 # 2 cores
ram: 2048 # memory in MB
protection: true
network:
  - index: 0
    mac: !expr "mac('A2:B1:C1', host.index, net.index, vmid)"
    secret: !secret guest_password # secret comment
`;

    const doc = loadYamlDocument(text);
    setScalar(doc, 'ram', 4096);

    const result = dumpYamlDocument(doc);
    expect(result).toContain('ram: 4096 # memory in MB');
    expect(result).toContain('cpu: 2 # 2 cores');
    expect(result).toContain(
      'mac: !expr "mac(\'A2:B1:C1\', host.index, net.index, vmid)"',
    );
    expect(result).toContain('secret: !secret guest_password # secret comment');

    const originalLines = text.split('\n');
    const resultLines = result.split('\n');
    expect(resultLines.length).toBe(originalLines.length);

    let changedCount = 0;
    for (let i = 0; i < originalLines.length; i++) {
      if (originalLines[i] !== resultLines[i]) {
        changedCount++;
        expect(originalLines[i]).toBe('ram: 2048 # memory in MB');
        expect(resultLines[i]).toBe('ram: 4096 # memory in MB');
      }
    }
    expect(changedCount).toBe(1);
  });

  it('sets a TagValue on an existing scalar', () => {
    const text = 'cpu: 2 # cores\n';
    const doc = loadYamlDocument(text);
    setScalar(doc, 'cpu', { tag: 'env', value: 'HOST_CPU' });
    expect(dumpYamlDocument(doc)).toBe('cpu: !env HOST_CPU # cores\n');
  });

  it('sets a TagValue that requires quotes', () => {
    const text = 'mac: !expr "old"\n';
    const doc = loadYamlDocument(text);
    setScalar(doc, 'mac', { tag: 'expr', value: "mac('A2', 1)" });
    expect(dumpYamlDocument(doc)).toBe('mac: !expr "mac(\'A2\', 1)"\n');
  });

  it('replaces a TagValue with a literal scalar', () => {
    const text = 'password: !secret my_pw # keep this\n';
    const doc = loadYamlDocument(text);
    setScalar(doc, 'password', 'plain123');
    expect(dumpYamlDocument(doc)).toBe('password: plain123 # keep this\n');
  });

  it('creates a new key when setting scalar if not existing', () => {
    const text = 'cpu: 2\n';
    const doc = loadYamlDocument(text);
    setScalar(doc, 'ram', 2048);
    expect(dumpYamlDocument(doc)).toBe('cpu: 2\nram: 2048\n');
  });

  it('throws when setting scalar on document root', () => {
    const doc = loadYamlDocument('cpu: 2\n');
    expect(() => setScalar(doc, '', 42)).toThrow(
      'Cannot set scalar at document root',
    );
  });

  it('gets a node with getYamlNode', () => {
    const doc = loadYamlDocument('nested:\n  val: 10\n');
    expect(getYamlNode(doc, 'nested.val')).toBeDefined();
    expect(getYamlNode(doc, ['nested', 'val'])).toBeDefined();
  });
});

describe('Tags wrapping and stringification', () => {
  it('creates tag scalar with plain value or quotes', () => {
    const plain = createTagScalar('env', 'FOO');
    expect(plain.type).toBeUndefined();
    const quoted = createTagScalar('expr', "val('x')");
    expect(quoted.type).toBe(Scalar.QUOTE_DOUBLE);
  });

  it('wraps tagged values and leaves plain values untouched', () => {
    expect(wrapTaggedValue('plain')).toBe('plain');
    const wrapped = wrapTaggedValue({ tag: 'secret', value: 'pw' });
    expect(wrapped).toBeInstanceOf(Scalar);
  });

  it('stringifies single-quoted tags', () => {
    const text = "item: !secret 'quoted'\n";
    const doc = loadYamlDocument(text);
    expect(dumpYamlDocument(doc)).toBe("item: !secret 'quoted'\n");
  });

  it('stringifies plain tags with no special characters', () => {
    const text = 'item: !env SIMPLE\n';
    const doc = loadYamlDocument(text);
    expect(dumpYamlDocument(doc)).toBe('item: !env SIMPLE\n');
  });
});

describe('Path normalization', () => {
  it('normalizes string and array paths', () => {
    expect(normalizeYamlPath('a.b.0.c')).toEqual(['a', 'b', 0, 'c']);
    expect(normalizeYamlPath(['a', 1, 'b'])).toEqual(['a', 1, 'b']);
    expect(normalizeYamlPath('')).toEqual([]);
    expect(normalizeYamlPath(null as unknown as string)).toEqual([]);
  });
});

describe('Map mutations (insertKey, removeKey)', () => {
  it('inserts key after another key', () => {
    const text = 'a: 1\nb: 2\nd: 4\n';
    const doc = loadYamlDocument(text);
    insertKey(doc, '', 'c', 3, { after: 'b' });
    expect(dumpYamlDocument(doc)).toBe('a: 1\nb: 2\nc: 3\nd: 4\n');
  });

  it('inserts key before another key', () => {
    const text = 'a: 1\nc: 3\n';
    const doc = loadYamlDocument(text);
    insertKey(doc, '', 'b', 2, { before: 'c' });
    expect(dumpYamlDocument(doc)).toBe('a: 1\nb: 2\nc: 3\n');
  });

  it('inserts key at end if after/before not found or not given', () => {
    const text = 'a: 1\n';
    const doc = loadYamlDocument(text);
    insertKey(doc, '', 'b', 2);
    expect(dumpYamlDocument(doc)).toBe('a: 1\nb: 2\n');
  });

  it('replaces existing key position when inserting duplicate', () => {
    const text = 'a: 1\nb: 2\n';
    const doc = loadYamlDocument(text);
    insertKey(doc, '', 'a', 99, { after: 'b' });
    expect(dumpYamlDocument(doc)).toBe('b: 2\na: 99\n');
  });

  it('throws when inserting into non-map', () => {
    const doc = loadYamlDocument('- item1\n- item2\n');
    expect(() => insertKey(doc, '', 'key', 'val')).toThrow('not a YAML map');
  });

  it('removes an existing key', () => {
    const text = 'a: 1\nb: 2 # comment\nc: 3\n';
    const doc = loadYamlDocument(text);
    const removed = removeKey(doc, 'b');
    expect(removed).toBe(true);
    expect(dumpYamlDocument(doc)).toBe('a: 1\nc: 3\n');
  });

  it('returns false when key or parent does not exist or parent is not a map', () => {
    const doc = loadYamlDocument('a: 1\nlist:\n  - 10\n');
    expect(removeKey(doc, 'missing')).toBe(false);
    expect(removeKey(doc, '')).toBe(false);
    expect(removeKey(doc, 'list.0')).toBe(false);
  });
});

describe('List mutations (appendToList, removeFromList)', () => {
  it('appends to list', () => {
    const text = 'items:\n  - one\n';
    const doc = loadYamlDocument(text);
    appendToList(doc, 'items', 'two');
    expect(dumpYamlDocument(doc)).toBe('items:\n  - one\n  - two\n');
  });

  it('appends a TagValue to list', () => {
    const text = 'keys:\n  - existing\n';
    const doc = loadYamlDocument(text);
    appendToList(doc, 'keys', { tag: 'secret', value: 'key2' });
    expect(dumpYamlDocument(doc)).toBe(
      'keys:\n  - existing\n  - !secret key2\n',
    );
  });

  it('throws when appending to non-list', () => {
    const doc = loadYamlDocument('a: 1\n');
    expect(() => appendToList(doc, 'a', 2)).toThrow('not a YAML list');
  });

  it('removes from list by index', () => {
    const text = 'items:\n  - zero\n  - one\n  - two\n';
    const doc = loadYamlDocument(text);
    const removed = removeFromList(doc, 'items', 1);
    expect(removed).toBe(true);
    expect(dumpYamlDocument(doc)).toBe('items:\n  - zero\n  - two\n');
  });

  it('returns false for invalid list removal index or non-list', () => {
    const doc = loadYamlDocument('items:\n  - zero\n');
    expect(removeFromList(doc, 'items', -1)).toBe(false);
    expect(removeFromList(doc, 'items', 5)).toBe(false);
    expect(removeFromList(doc, 'missing', 0)).toBe(false);
  });
});

describe('yamlDocumentToJS', () => {
  it('converts to plain JS with TagValue objects', () => {
    const text = `
cpu: 2
secret: !secret my_sec
network:
  - mac: !expr "mac('A', 1)"
`;
    const doc = loadYamlDocument(text);
    interface SampleDoc {
      cpu: number;
      secret: unknown;
      network: { mac: unknown }[];
    }
    const js = yamlDocumentToJS<SampleDoc>(doc);
    expect(js.cpu).toBe(2);
    expect(isTagValue(js.secret)).toBe(true);
    expect(js.secret).toEqual({ tag: 'secret', value: 'my_sec' });
    expect(js.network[0]!.mac).toEqual({ tag: 'expr', value: "mac('A', 1)" });
  });
});

describe('dumpYamlDocument EOL handling', () => {
  it('preserves CRLF when rendered text has CRLF', () => {
    const doc = loadYamlDocument('cpu: 2\r\nram: 1024\r\n');
    const dumped = dumpYamlDocument(doc, { eol: '\r\n' });
    expect(dumped).toBe('cpu: 2\r\nram: 1024\r\n');
  });
});

describe('readYamlFile and writeYamlFile', () => {
  it('reads file with LF, preserves mode', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'hacm-yaml-test-'));
    try {
      const file = join(tempDir, 'test-lf.yaml');
      const content = 'cpu: 2\nram: 1024\n';
      await writeFile(file, content, { encoding: 'utf8', mode: 0o644 });

      const result = await readYamlFile(file);
      expect(result.eol).toBe('\n');
      expect(result.raw).toBe(content);
      expect(
        yamlDocumentToJS<Record<string, unknown>>(result.document).cpu,
      ).toBe(2);

      await writeYamlFile(file, result.document, { mode: 0o600 });
      const updated = await readFile(file, 'utf8');
      expect(updated).toBe('cpu: 2\nram: 1024\n');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reads file preserving mode and CRLF', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'hacm-yaml-test-'));
    try {
      const file = join(tempDir, 'test.yaml');
      const content = 'cpu: 2\r\nram: 1024\r\n';
      await writeFile(file, content, { encoding: 'utf8', mode: 0o640 });

      const result = await readYamlFile(file);
      expect(result.eol).toBe('\r\n');
      expect(result.raw).toBe(content);
      expect(
        yamlDocumentToJS<Record<string, unknown>>(result.document).cpu,
      ).toBe(2);

      setScalar(result.document, 'ram', 2048);
      await writeYamlFile(file, result.document, { eol: result.eol });

      const updated = await readFile(file, 'utf8');
      expect(updated).toBe('cpu: 2\r\nram: 2048\r\n');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('supports non-atomic write', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'hacm-yaml-test-'));
    try {
      const file = join(tempDir, 'test-non-atomic.yaml');
      const doc = loadYamlDocument('hello: world\n');
      await writeYamlFile(file, doc, { atomic: false });
      const readBack = await readFile(file, 'utf8');
      expect(readBack).toBe('hello: world\n');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('cleans up temp file on write error', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'hacm-yaml-test-'));
    try {
      const file = join(tempDir, 'forbidden/file.yaml');
      const doc = loadYamlDocument('a: 1\n');
      await expect(writeYamlFile(file, doc)).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
