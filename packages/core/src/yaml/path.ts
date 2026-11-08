export type YamlPath = string | readonly (string | number)[];

export function normalizeYamlPath(path: YamlPath): (string | number)[] {
  if (Array.isArray(path)) {
    return [...path];
  }
  if (typeof path !== 'string' || path === '') return [];
  return path.split('.').map((segment) => {
    const parsedNum = Number(segment);
    return Number.isInteger(parsedNum) && String(parsedNum) === segment
      ? parsedNum
      : segment;
  });
}
