import { Scalar, type ScalarTag } from 'yaml';
import { isTagValue, tagNames, type TagName } from '../schema/common.js';

export function createTagScalar(tag: TagName, value: string): Scalar {
  const scalar = new Scalar({ tag, value });
  scalar.tag = `!${tag}`;
  if (
    value.includes(' ') ||
    value.includes('(') ||
    value.includes("'") ||
    value.includes('"')
  ) {
    scalar.type = Scalar.QUOTE_DOUBLE;
  }
  return scalar;
}

export function wrapTaggedValue(value: unknown): unknown {
  if (isTagValue(value)) {
    return createTagScalar(value.tag, value.value);
  }
  return value;
}

export const customYamlTags: ScalarTag[] = tagNames.map((name) => ({
  tag: `!${name}`,
  resolve(value: string) {
    const scalar = new Scalar({ tag: name, value });
    scalar.tag = `!${name}`;
    return scalar;
  },
  stringify(item: Scalar) {
    const val = item.value as unknown;
    const strVal =
      typeof val === 'object' && val !== null && 'value' in val
        ? String((val as { value: unknown }).value)
        : String(val);

    if (
      item.type === Scalar.QUOTE_DOUBLE ||
      strVal.includes("'") ||
      strVal.includes('(') ||
      strVal.includes(' ')
    ) {
      return JSON.stringify(strVal);
    }
    if (item.type === Scalar.QUOTE_SINGLE) {
      return `'${strVal.replaceAll("'", "''")}'`;
    }
    return strVal;
  },
}));
