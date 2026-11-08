import { describe, expect, it } from 'vitest';
import {
  evaluateExpression,
  ExpressionError,
  ExpressionLimitError,
  ExpressionSecurityError,
  ExpressionSyntaxError,
  MacRangeError,
  parse,
  tokenize,
} from './index.js';

describe('Safe Expression Engine (!expr)', () => {
  describe('D-08 Deterministic MAC Scheme', () => {
    it('reproduces the spec example A2:B1:C1:01:E0:12', () => {
      const result = evaluateExpression(
        "mac('A2:B1:C1', host.index, net.index, vmid)",
        {
          host: { id: 'pve1', index: 1, name: 'example-host' },
          net: { index: 0, bridge: 'vmbr0' },
          vmid: 112,
        },
      );
      expect(result).toBe('A2:B1:C1:01:E0:12');
    });

    it('handles lowercase prefix and formats to uppercase', () => {
      const result = evaluateExpression("mac('a2:b1:c1', 5, 2, 105)");
      expect(result).toBe('A2:B1:C1:05:E2:05');
    });

    it('fails loudly when vmid >= 200 (overflow)', () => {
      expect(() => evaluateExpression("mac('A2:B1:C1', 1, 0, 200)")).toThrow(
        MacRangeError,
      );
      expect(() => evaluateExpression("mac('A2:B1:C1', 1, 0, 200)")).toThrow(
        /vmid must be an integer between 100 and 199/,
      );
    });

    it('fails loudly when vmid < 100', () => {
      expect(() => evaluateExpression("mac('A2:B1:C1', 1, 0, 99)")).toThrow(
        MacRangeError,
      );
    });

    it('fails loudly when host.index > 99', () => {
      expect(() => evaluateExpression("mac('A2:B1:C1', 100, 0, 112)")).toThrow(
        MacRangeError,
      );
      expect(() => evaluateExpression("mac('A2:B1:C1', 100, 0, 112)")).toThrow(
        /host\.index must be an integer between 0 and 99/,
      );
    });

    it('fails loudly when host.index < 0', () => {
      expect(() => evaluateExpression("mac('A2:B1:C1', -1, 0, 112)")).toThrow(
        MacRangeError,
      );
    });

    it('fails loudly when net.index >= 10', () => {
      expect(() => evaluateExpression("mac('A2:B1:C1', 1, 10, 112)")).toThrow(
        MacRangeError,
      );
      expect(() => evaluateExpression("mac('A2:B1:C1', 1, 10, 112)")).toThrow(
        /net\.index must be an integer between 0 and 9/,
      );
    });

    it('fails loudly when net.index < 0', () => {
      expect(() => evaluateExpression("mac('A2:B1:C1', 1, -1, 112)")).toThrow(
        MacRangeError,
      );
    });

    it('fails loudly with invalid prefix', () => {
      expect(() =>
        evaluateExpression("mac('invalid-prefix', 1, 0, 112)"),
      ).toThrow(MacRangeError);
      expect(() => evaluateExpression('mac(123, 1, 0, 112)')).toThrow(
        MacRangeError,
      );
    });

    it('fails loudly with non-integer arguments', () => {
      expect(() =>
        evaluateExpression("mac('A2:B1:C1', 'not-a-number', 0, 112)"),
      ).toThrow(MacRangeError);
    });
  });

  describe('Built-in helpers', () => {
    it('pad helper pads numbers and strings', () => {
      expect(evaluateExpression('pad(5, 3)')).toBe('005');
      expect(evaluateExpression("pad('xyz', 6, '-')")).toBe('---xyz');
      expect(evaluateExpression("pad('abc', 2)")).toBe('abc');
      expect(evaluateExpression('pad(null, 2)')).toBe('00');
    });

    it('pad helper rejects invalid length', () => {
      expect(() => evaluateExpression("pad('x', -1)")).toThrow(ExpressionError);
      expect(() => evaluateExpression("pad('x', 2000)")).toThrow(
        ExpressionError,
      );
    });

    it('hex helper formats integer to uppercase hex', () => {
      expect(evaluateExpression('hex(255)')).toBe('FF');
      expect(evaluateExpression('hex(10, 4)')).toBe('000A');
      expect(evaluateExpression('hex(0)')).toBe('00');
    });

    it('hex helper rejects invalid values and digits', () => {
      expect(() => evaluateExpression("hex('abc')")).toThrow(ExpressionError);
      expect(() => evaluateExpression('hex(1, 0)')).toThrow(ExpressionError);
      expect(() => evaluateExpression('hex(1, 50)')).toThrow(ExpressionError);
    });

    it('ip_add offsets IPv4 and CIDR addresses', () => {
      expect(evaluateExpression("ip_add('192.168.1.10', 5)")).toBe(
        '192.168.1.15',
      );
      expect(evaluateExpression("ip_add('192.168.1.10/24', 5)")).toBe(
        '192.168.1.15/24',
      );
      expect(evaluateExpression("ip_add('192.168.1.10', -5)")).toBe(
        '192.168.1.5',
      );
    });

    it('ip_add rejects invalid inputs', () => {
      expect(() => evaluateExpression('ip_add(123, 5)')).toThrow(
        ExpressionError,
      );
      expect(() => evaluateExpression("ip_add('192.168.1.1', 'abc')")).toThrow(
        ExpressionError,
      );
      expect(() => evaluateExpression("ip_add('999.1.1.1', 1)")).toThrow(
        ExpressionError,
      );
      expect(() => evaluateExpression("ip_add('not-an-ip', 1)")).toThrow(
        ExpressionError,
      );
      expect(() => evaluateExpression("ip_add('1.1.1.1/33', 1)")).toThrow(
        ExpressionError,
      );
      expect(() => evaluateExpression("ip_add('1.1.1.1/24/30', 1)")).toThrow(
        ExpressionError,
      );
    });

    it('ip_calc calculates target IP in subnet', () => {
      expect(evaluateExpression("ip_calc('192.168.1.0/24', 112)")).toBe(
        '192.168.1.112',
      );
      expect(evaluateExpression("ip_calc('10.0.0.0/16', 500)")).toBe(
        '10.0.1.244',
      );
    });

    it('ip_calc rejects invalid inputs', () => {
      expect(() => evaluateExpression('ip_calc(123, 1)')).toThrow(
        ExpressionError,
      );
      expect(() => evaluateExpression("ip_calc('192.168.1.0/24', -1)")).toThrow(
        ExpressionError,
      );
    });

    it('cidr_gateway, cidr_netmask and cidr_prefix return subnet properties', () => {
      expect(evaluateExpression("cidr_gateway('192.168.1.0/24')")).toBe(
        '192.168.1.1',
      );
      expect(evaluateExpression("cidr_netmask('192.168.1.0/24')")).toBe(
        '255.255.255.0',
      );
      expect(evaluateExpression("cidr_netmask('10.0.0.0/8')")).toBe(
        '255.0.0.0',
      );
      expect(evaluateExpression("cidr_prefix('192.168.1.0/24')")).toBe(24);
      expect(evaluateExpression("cidr_prefix('192.168.1.1')")).toBe(32);
    });

    it('cidr helpers reject non-string inputs', () => {
      expect(() => evaluateExpression('cidr_netmask(123)')).toThrow(
        ExpressionError,
      );
      expect(() => evaluateExpression('cidr_prefix(123)')).toThrow(
        ExpressionError,
      );
    });
  });

  describe('Context and Member Access', () => {
    it('accesses variables from EvaluationContext', () => {
      const ctx = {
        host: { id: 'pve1', index: 3, name: 'node-3' },
        guest: { id: 105, name: 'web-srv', type: 'lxc' as const },
        net: { index: 1, bridge: 'vmbr1', name: 'eth1' },
        vmid: 105,
      };

      expect(evaluateExpression('host.name', ctx)).toBe('node-3');
      expect(evaluateExpression('host.index', ctx)).toBe(3);
      expect(evaluateExpression('guest.name', ctx)).toBe('web-srv');
      expect(evaluateExpression('net.bridge', ctx)).toBe('vmbr1');
      expect(evaluateExpression('vmid', ctx)).toBe(105);
    });

    it('supports bracket member access and computed property access', () => {
      const ctx = {
        items: ['first', 'second', 'third'],
        keys: { 'special-key': 'val1', sub: { '0': 'sub-val' } },
        idx: 1,
      };

      expect(evaluateExpression('items[0]', ctx)).toBe('first');
      expect(evaluateExpression('items[idx]', ctx)).toBe('second');
      expect(evaluateExpression("keys['special-key']", ctx)).toBe('val1');
    });

    it('returns undefined for non-existent variables or properties', () => {
      expect(evaluateExpression('unknown_var')).toBeUndefined();
      expect(evaluateExpression('host.missing', { host: {} })).toBeUndefined();
      expect(evaluateExpression('host.missing.deep', {})).toBeUndefined();
      expect(
        evaluateExpression('null_val.prop', { null_val: null }),
      ).toBeUndefined();
    });
  });

  describe('Operators and Expressions', () => {
    it('evaluates arithmetic operations', () => {
      expect(evaluateExpression('1 + 2 * 3')).toBe(7);
      expect(evaluateExpression('(1 + 2) * 3')).toBe(9);
      expect(evaluateExpression('10 - 4 - 2')).toBe(4);
      expect(evaluateExpression('20 / 4')).toBe(5);
      expect(evaluateExpression('10 % 3')).toBe(1);
    });

    it('throws on division or modulo by zero', () => {
      expect(() => evaluateExpression('10 / 0')).toThrow(/Division by zero/);
      expect(() => evaluateExpression('10 % 0')).toThrow(/Modulo by zero/);
    });

    it('evaluates unary operators', () => {
      expect(evaluateExpression('-5')).toBe(-5);
      expect(evaluateExpression('+5')).toBe(5);
      expect(evaluateExpression('!true')).toBe(false);
      expect(evaluateExpression('!false')).toBe(true);
      expect(evaluateExpression('!!1')).toBe(true);
    });

    it('evaluates string concatenation', () => {
      expect(evaluateExpression("'hello ' + 'world'")).toBe('hello world');
      expect(evaluateExpression("'guest-' + 112")).toBe('guest-112');
      expect(evaluateExpression("112 + '-lxc'")).toBe('112-lxc');
    });

    it('evaluates comparisons', () => {
      expect(evaluateExpression('1 == 1')).toBe(true);
      expect(evaluateExpression('1 != 2')).toBe(true);
      expect(evaluateExpression('1 < 2')).toBe(true);
      expect(evaluateExpression('2 <= 2')).toBe(true);
      expect(evaluateExpression('3 > 2')).toBe(true);
      expect(evaluateExpression('3 >= 3')).toBe(true);
      expect(evaluateExpression('1 > 2')).toBe(false);
    });

    it('evaluates short-circuit logical operators', () => {
      expect(evaluateExpression('true && true')).toBe(true);
      expect(evaluateExpression('false && unknown_var')).toBe(false);
      expect(evaluateExpression('true || unknown_var')).toBe(true);
      expect(evaluateExpression('false || true')).toBe(true);
      expect(evaluateExpression("'a' && 'b'")).toBe('b');
    });

    it('evaluates conditional ternary operator', () => {
      expect(evaluateExpression("true ? 'yes' : 'no'")).toBe('yes');
      expect(evaluateExpression("false ? 'yes' : 'no'")).toBe('no');
      expect(
        evaluateExpression("vmid > 100 ? 'high' : 'low'", { vmid: 105 }),
      ).toBe('high');
      expect(
        evaluateExpression("vmid > 100 ? 'high' : 'low'", { vmid: 50 }),
      ).toBe('low');
    });

    it('supports custom caller-provided helpers', () => {
      const customHelpers = {
        double: (n: unknown) => Number(n) * 2,
        concat: (a: unknown, b: unknown) => `${String(a)}_${String(b)}`,
      };
      expect(
        evaluateExpression('double(21)', {}, { helpers: customHelpers }),
      ).toBe(42);
      expect(
        evaluateExpression(
          "concat('foo', 'bar')",
          {},
          { helpers: customHelpers },
        ),
      ).toBe('foo_bar');
    });
  });

  describe('Security & Isolation', () => {
    it('blocks access to constructor and prototype properties', () => {
      expect(() => evaluateExpression("('abc').constructor")).toThrow(
        ExpressionSecurityError,
      );
      expect(() => evaluateExpression('obj.__proto__', { obj: {} })).toThrow(
        ExpressionSecurityError,
      );
      expect(() =>
        evaluateExpression("host['__proto__']", { host: {} }),
      ).toThrow(ExpressionSecurityError);
      expect(() =>
        evaluateExpression("host['constructor']", { host: {} }),
      ).toThrow(ExpressionSecurityError);
    });

    it('blocks access to global and system identifiers', () => {
      expect(() => evaluateExpression('window')).toThrow(
        ExpressionSecurityError,
      );
      expect(() => evaluateExpression('global')).toThrow(
        ExpressionSecurityError,
      );
      expect(() => evaluateExpression('globalThis')).toThrow(
        ExpressionSecurityError,
      );
      expect(() => evaluateExpression('process')).toThrow(
        ExpressionSecurityError,
      );
      expect(() => evaluateExpression('require')).toThrow(
        ExpressionSecurityError,
      );
      expect(() => evaluateExpression('Function')).toThrow(
        ExpressionSecurityError,
      );
      expect(() => evaluateExpression('eval')).toThrow(ExpressionSecurityError);
    });

    it('blocks calling forbidden functions', () => {
      expect(() => evaluateExpression('constructor()')).toThrow(
        ExpressionSecurityError,
      );
      expect(() => evaluateExpression('eval("1+1")')).toThrow(
        ExpressionSecurityError,
      );
    });

    it('throws when calling unknown function', () => {
      expect(() => evaluateExpression('non_existent_func(1, 2)')).toThrow(
        /Unknown function: 'non_existent_func'/,
      );
    });
  });

  describe('Resource & Execution Limits', () => {
    it('throws when expression length exceeds limit', () => {
      const longExpr = '1 + '.repeat(300) + '1';
      expect(() =>
        evaluateExpression(
          longExpr,
          {},
          { limits: { maxExpressionLength: 100 } },
        ),
      ).toThrow(ExpressionLimitError);
    });

    it('throws when step count exceeds maxSteps limit', () => {
      const complexExpr = '1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10';
      expect(() =>
        evaluateExpression(complexExpr, {}, { limits: { maxSteps: 5 } }),
      ).toThrow(ExpressionLimitError);
    });

    it('throws when expression nesting depth exceeds maxDepth limit', () => {
      const deepExpr = '1 + (1 + (1 + (1 + (1 + 1))))';
      expect(() =>
        evaluateExpression(deepExpr, {}, { limits: { maxDepth: 4 } }),
      ).toThrow(ExpressionLimitError);
    });
  });

  describe('Parser and Tokenizer error handling', () => {
    it('handles empty expression', () => {
      expect(() => evaluateExpression('')).toThrow(ExpressionSyntaxError);
      expect(() => evaluateExpression('   ')).toThrow(ExpressionSyntaxError);
    });

    it('handles unterminated string', () => {
      expect(() => evaluateExpression("'unclosed")).toThrow(
        ExpressionSyntaxError,
      );
      expect(() => evaluateExpression('"unclosed')).toThrow(
        ExpressionSyntaxError,
      );
    });

    it('handles escape sequences in strings', () => {
      expect(evaluateExpression("'line1\\nline2'")).toBe('line1\nline2');
      expect(evaluateExpression("'tab\\there'")).toBe('tab\there');
      expect(evaluateExpression("'slash\\\\quote\\''")).toBe("slash\\quote'");
    });

    it('handles unexpected characters', () => {
      expect(() => tokenize('@foo')).toThrow(ExpressionSyntaxError);
    });

    it('handles syntax errors in expressions', () => {
      expect(() => parse('1 +')).toThrow(ExpressionSyntaxError);
      expect(() => parse('(1 + 2')).toThrow(ExpressionSyntaxError);
      expect(() => parse('true ? 1')).toThrow(ExpressionSyntaxError);
      expect(() => parse('1 2')).toThrow(ExpressionSyntaxError);
      expect(() => parse('(1 + 2)()')).toThrow(
        /Only named functions can be called/,
      );
    });
  });
});
