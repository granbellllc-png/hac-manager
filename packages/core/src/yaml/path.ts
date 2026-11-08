export type YamlPath = string | readonly (string | number)[];

export function normalizeYamlPath(path: YamlPath): (string | number)[] {
  if (Array.isArray(path)) {
    return [...path];
  }
  if (typeof path !== 'string' || path === '') return [];

  const parts: (string | number)[] = [];
  const regex = /([^[.\]]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(path)) !== null) {
    const segment = match[1]!;
    const parsedNum = Number(segment);
    if (Number.isInteger(parsedNum) && String(parsedNum) === segment) {
      parts.push(parsedNum);
    } else {
      parts.push(segment);
    }
  }
  return parts;
}

export function formatYamlPath(path: readonly (string | number)[]): string {
  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      result += `[${segment}]`;
    } else if (result.length > 0) {
      result += `.${segment}`;
    } else {
      result += segment;
    }
  }
  return result;
}
