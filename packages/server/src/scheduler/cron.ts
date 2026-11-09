export class CronExpressionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CronExpressionError';
  }
}

interface CronField {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
}

export interface ParsedCronExpression {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

function integer(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CronExpressionError(`${label} contains invalid value '${value}'`);
  }
  return Number(value);
}

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  label: string,
  normalize: (value: number) => number = (value) => value,
): CronField {
  const values = new Set<number>();
  const wildcard = source === '*';
  for (const segment of source.split(',')) {
    if (!segment) {
      throw new CronExpressionError(`${label} contains an empty segment`);
    }
    const [base, rawStep, extra] = segment.split('/');
    if (extra !== undefined || !base) {
      throw new CronExpressionError(
        `${label} contains invalid segment '${segment}'`,
      );
    }
    const step = rawStep === undefined ? 1 : integer(rawStep, label);
    if (step < 1) {
      throw new CronExpressionError(`${label} step must be positive`);
    }

    let start: number;
    let end: number;
    if (base === '*') {
      start = minimum;
      end = maximum;
    } else if (base.includes('-')) {
      const parts = base.split('-');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new CronExpressionError(
          `${label} contains invalid range '${base}'`,
        );
      }
      start = integer(parts[0], label);
      end = integer(parts[1], label);
    } else {
      start = integer(base, label);
      end = start;
    }
    if (start < minimum || end > maximum || start > end) {
      throw new CronExpressionError(
        `${label} value '${base}' must be between ${minimum} and ${maximum}`,
      );
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalize(value));
    }
  }
  return { values, wildcard };
}

export function parseCronExpression(source: string): ParsedCronExpression {
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronExpressionError(
      `Expected five cron fields, received ${fields.length}`,
    );
  }
  return {
    minute: parseField(fields[0]!, 0, 59, 'minute'),
    hour: parseField(fields[1]!, 0, 23, 'hour'),
    dayOfMonth: parseField(fields[2]!, 1, 31, 'day of month'),
    month: parseField(fields[3]!, 1, 12, 'month'),
    dayOfWeek: parseField(fields[4]!, 0, 7, 'day of week', (value) =>
      value === 7 ? 0 : value,
    ),
  };
}

export function cronMatches(
  expression: string | ParsedCronExpression,
  date: Date,
): boolean {
  const cron =
    typeof expression === 'string'
      ? parseCronExpression(expression)
      : expression;
  const dayOfMonthMatches = cron.dayOfMonth.values.has(date.getUTCDate());
  const dayOfWeekMatches = cron.dayOfWeek.values.has(date.getUTCDay());
  const dayMatches =
    cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard
      ? true
      : cron.dayOfMonth.wildcard
        ? dayOfWeekMatches
        : cron.dayOfWeek.wildcard
          ? dayOfMonthMatches
          : dayOfMonthMatches || dayOfWeekMatches;
  return (
    cron.minute.values.has(date.getUTCMinutes()) &&
    cron.hour.values.has(date.getUTCHours()) &&
    cron.month.values.has(date.getUTCMonth() + 1) &&
    dayMatches
  );
}
