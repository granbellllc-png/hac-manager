export interface ParsedOptionString {
  readonly positional?: string | undefined;
  readonly options: Record<string, string>;
}

export function parseOptionString(str: string): ParsedOptionString {
  const parts = str
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  let positional: string | undefined = undefined;
  const options: Record<string, string> = {};

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) {
      if (i === 0 && !positional) {
        positional = part;
      } else {
        options[part] = '1';
      }
    } else {
      const key = part.slice(0, eqIdx).trim();
      const val = part.slice(eqIdx + 1).trim();
      options[key] = val;
    }
  }

  return { positional, options };
}

export function formatOptionString(
  positional?: string,
  options: Record<string, string | number | boolean | undefined> = {},
  order?: readonly string[],
): string {
  const parts: string[] = [];
  if (positional) {
    parts.push(positional);
  }

  const keys = Object.keys(options).filter(
    (k) => options[k] !== undefined && options[k] !== '',
  );
  if (order) {
    keys.sort((a, b) => {
      const idxA = order.indexOf(a);
      const idxB = order.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });
  } else {
    keys.sort();
  }

  for (const k of keys) {
    const val = options[k];
    if (val === true || val === '1') {
      parts.push(`${k}=1`);
    } else if (val === false || val === '0') {
      parts.push(`${k}=0`);
    } else {
      parts.push(`${k}=${String(val)}`);
    }
  }

  return parts.join(',');
}

export function parseSizeGb(sizeStr?: string): number {
  if (!sizeStr) return 0;
  const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*([KkMmGgTtPp])?$/);
  if (!match || !match[1]) return 0;
  const val = parseFloat(match[1]);
  const unit = (match[2] ?? 'G').toUpperCase();

  switch (unit) {
    case 'K':
      return Math.round((val / (1024 * 1024)) * 100) / 100;
    case 'M':
      return Math.round((val / 1024) * 100) / 100;
    case 'G':
      return val;
    case 'T':
      return val * 1024;
    default:
      return val;
  }
}

export function formatSizeGb(sizeGb: number): string {
  // If whole number, format without decimal, otherwise up to 2 decimal places
  const formatted = Number.isInteger(sizeGb)
    ? String(sizeGb)
    : sizeGb.toFixed(2);
  return `${formatted}G`;
}
