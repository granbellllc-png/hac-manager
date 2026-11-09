import { describe, expect, it } from 'vitest';
import {
  cronMatches,
  CronExpressionError,
  parseCronExpression,
} from './cron.js';

describe('cron expressions', () => {
  it('matches UTC wildcards, steps, ranges, lists, and Sunday aliases', () => {
    expect(cronMatches('* * * * *', new Date('2026-01-01T12:34:00Z'))).toBe(
      true,
    );
    expect(
      cronMatches('*/15 8-18 * * 1-5', new Date('2026-01-05T09:30:00Z')),
    ).toBe(true);
    expect(
      cronMatches('*/15 8-18 * * 1-5', new Date('2026-01-05T09:31:00Z')),
    ).toBe(false);
    expect(cronMatches('0 0 1,15 * *', new Date('2026-01-15T00:00:00Z'))).toBe(
      true,
    );
    expect(cronMatches('0 0 * * 7', new Date('2026-01-04T00:00:00Z'))).toBe(
      true,
    );
  });

  it('uses standard cron OR semantics for restricted month and week days', () => {
    const expression = parseCronExpression('0 12 15 * 1');
    expect(cronMatches(expression, new Date('2026-01-12T12:00:00Z'))).toBe(
      true,
    );
    expect(cronMatches(expression, new Date('2026-01-15T12:00:00Z'))).toBe(
      true,
    );
    expect(cronMatches(expression, new Date('2026-01-13T12:00:00Z'))).toBe(
      false,
    );
  });

  it.each([
    '',
    '* * * *',
    '60 * * * *',
    '*/0 * * * *',
    'x * * * *',
    '1-0 * * * *',
    '1-2-3 * * * *',
    '1,,2 * * * *',
  ])('rejects invalid expression %j', (expression) => {
    expect(() => parseCronExpression(expression)).toThrow(CronExpressionError);
  });
});
