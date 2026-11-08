import type { ASTNode } from './ast.js';
import { ExpressionLimitError, ExpressionSyntaxError } from './types.js';

interface Token {
  readonly type: 'NUMBER' | 'STRING' | 'IDENT' | 'PUNCT' | 'OP' | 'EOF';
  readonly value: string;
  readonly pos: number;
}

export function tokenize(input: string, maxLength = 1024): Token[] {
  if (input.length > maxLength) {
    throw new ExpressionLimitError(
      `Expression length (${input.length}) exceeds maximum allowed length (${maxLength})`,
    );
  }

  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    const pos = i;

    // Two-character operators
    if (i + 1 < input.length) {
      const two = input.slice(i, i + 2);
      if (
        two === '==' ||
        two === '!=' ||
        two === '<=' ||
        two === '>=' ||
        two === '&&' ||
        two === '||'
      ) {
        tokens.push({ type: 'OP', value: two, pos });
        i += 2;
        continue;
      }
    }

    // Single-character operators
    if (
      ch === '+' ||
      ch === '-' ||
      ch === '*' ||
      ch === '/' ||
      ch === '%' ||
      ch === '<' ||
      ch === '>' ||
      ch === '!'
    ) {
      tokens.push({ type: 'OP', value: ch, pos });
      i++;
      continue;
    }

    // Punctuation
    if (
      ch === '(' ||
      ch === ')' ||
      ch === '[' ||
      ch === ']' ||
      ch === '{' ||
      ch === '}' ||
      ch === ',' ||
      ch === '.' ||
      ch === '?' ||
      ch === ':'
    ) {
      tokens.push({ type: 'PUNCT', value: ch, pos });
      i++;
      continue;
    }

    // String literals ('...' or "...")
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let str = '';
      i++; // skip opening quote
      let closed = false;

      while (i < input.length) {
        const c = input[i]!;
        if (c === '\\' && i + 1 < input.length) {
          const next = input[i + 1]!;
          if (next === 'n') str += '\n';
          else if (next === 'r') str += '\r';
          else if (next === 't') str += '\t';
          else if (next === '\\') str += '\\';
          else if (next === quote) str += quote;
          else str += next;
          i += 2;
        } else if (c === quote) {
          closed = true;
          i++; // skip closing quote
          break;
        } else {
          str += c;
          i++;
        }
      }

      if (!closed) {
        throw new ExpressionSyntaxError('Unterminated string literal', pos);
      }

      tokens.push({ type: 'STRING', value: str, pos });
      continue;
    }

    // Number literals
    if (/\d/.test(ch)) {
      let numStr = '';
      while (i < input.length && /[\d.]/.test(input[i]!)) {
        numStr += input[i]!;
        i++;
      }
      tokens.push({ type: 'NUMBER', value: numStr, pos });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i]!)) {
        ident += input[i]!;
        i++;
      }
      tokens.push({ type: 'IDENT', value: ident, pos });
      continue;
    }

    throw new ExpressionSyntaxError(`Unexpected character '${ch}'`, pos);
  }

  tokens.push({ type: 'EOF', value: '', pos: input.length });
  return tokens;
}

export class Parser {
  private current = 0;

  public constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    return this.tokens[this.current]!;
  }

  private isAtEnd(): boolean {
    return this.peek().type === 'EOF';
  }

  private advance(): Token {
    if (!this.isAtEnd()) this.current++;
    return this.tokens[this.current - 1]!;
  }

  private check(type: Token['type'], value?: string): boolean {
    if (this.isAtEnd()) return false;
    const token = this.peek();
    if (token.type !== type) return false;
    if (value !== undefined && token.value !== value) return false;
    return true;
  }

  private match(type: Token['type'], value?: string): boolean {
    if (this.check(type, value)) {
      this.advance();
      return true;
    }
    return false;
  }

  private consume(
    type: Token['type'],
    value?: string,
    message?: string,
  ): Token {
    if (this.check(type, value)) {
      return this.advance();
    }
    const token = this.peek();
    const expected = value ? `'${value}'` : type;
    throw new ExpressionSyntaxError(
      message ?? `Expected ${expected}, found '${token.value || token.type}'`,
      token.pos,
    );
  }

  public parse(): ASTNode {
    const expr = this.parseConditional();
    if (!this.isAtEnd()) {
      const token = this.peek();
      throw new ExpressionSyntaxError(
        `Unexpected token '${token.value}' after expression`,
        token.pos,
      );
    }
    return expr;
  }

  // 1. Conditional: test ? consequent : alternate
  private parseConditional(): ASTNode {
    const expr = this.parseLogicalOr();

    if (this.match('PUNCT', '?')) {
      const consequent = this.parseConditional();
      this.consume('PUNCT', ':', "Expected ':' in conditional expression");
      const alternate = this.parseConditional();
      return {
        type: 'conditional',
        test: expr,
        consequent,
        alternate,
        pos: expr.pos,
      };
    }

    return expr;
  }

  // 2. Logical OR: ||
  private parseLogicalOr(): ASTNode {
    let expr = this.parseLogicalAnd();

    while (this.match('OP', '||')) {
      const right = this.parseLogicalAnd();
      expr = {
        type: 'binary',
        op: '||',
        left: expr,
        right,
        pos: expr.pos,
      };
    }

    return expr;
  }

  // 3. Logical AND: &&
  private parseLogicalAnd(): ASTNode {
    let expr = this.parseEquality();

    while (this.match('OP', '&&')) {
      const right = this.parseEquality();
      expr = {
        type: 'binary',
        op: '&&',
        left: expr,
        right,
        pos: expr.pos,
      };
    }

    return expr;
  }

  // 4. Equality: ==, !=
  private parseEquality(): ASTNode {
    let expr = this.parseRelational();

    while (this.check('OP', '==') || this.check('OP', '!=')) {
      const opToken = this.advance();
      const right = this.parseRelational();
      expr = {
        type: 'binary',
        op: opToken.value as '==' | '!=',
        left: expr,
        right,
        pos: expr.pos,
      };
    }

    return expr;
  }

  // 5. Relational: <, <=, >, >=
  private parseRelational(): ASTNode {
    let expr = this.parseAdditive();

    while (
      this.check('OP', '<') ||
      this.check('OP', '<=') ||
      this.check('OP', '>') ||
      this.check('OP', '>=')
    ) {
      const opToken = this.advance();
      const right = this.parseAdditive();
      expr = {
        type: 'binary',
        op: opToken.value as '<' | '<=' | '>' | '>=',
        left: expr,
        right,
        pos: expr.pos,
      };
    }

    return expr;
  }

  // 6. Additive: +, -
  private parseAdditive(): ASTNode {
    let expr = this.parseMultiplicative();

    while (this.check('OP', '+') || this.check('OP', '-')) {
      const opToken = this.advance();
      const right = this.parseMultiplicative();
      expr = {
        type: 'binary',
        op: opToken.value as '+' | '-',
        left: expr,
        right,
        pos: expr.pos,
      };
    }

    return expr;
  }

  // 7. Multiplicative: *, /, %
  private parseMultiplicative(): ASTNode {
    let expr = this.parseUnary();

    while (
      this.check('OP', '*') ||
      this.check('OP', '/') ||
      this.check('OP', '%')
    ) {
      const opToken = this.advance();
      const right = this.parseUnary();
      expr = {
        type: 'binary',
        op: opToken.value as '*' | '/' | '%',
        left: expr,
        right,
        pos: expr.pos,
      };
    }

    return expr;
  }

  // 8. Unary: !, -, +
  private parseUnary(): ASTNode {
    if (
      this.check('OP', '!') ||
      this.check('OP', '-') ||
      this.check('OP', '+')
    ) {
      const opToken = this.advance();
      const operand = this.parseUnary();
      return {
        type: 'unary',
        op: opToken.value as '!' | '-' | '+',
        operand,
        pos: opToken.pos,
      };
    }

    return this.parsePostfix();
  }

  // 9. Postfix: member access (.prop, [computed]), function call (arg1, arg2)
  private parsePostfix(): ASTNode {
    let expr = this.parsePrimary();

    while (true) {
      if (this.match('PUNCT', '.')) {
        const propToken = this.consume(
          'IDENT',
          undefined,
          "Expected property name after '.'",
        );
        expr = {
          type: 'member',
          object: expr,
          property: propToken.value,
          computed: false,
          pos: expr.pos,
        };
      } else if (this.match('PUNCT', '[')) {
        const indexExpr = this.parseConditional();
        this.consume('PUNCT', ']', "Expected ']' after index expression");
        expr = {
          type: 'member',
          object: expr,
          property: indexExpr,
          computed: true,
          pos: expr.pos,
        };
      } else if (this.match('PUNCT', '(')) {
        if (expr.type !== 'identifier') {
          throw new ExpressionSyntaxError(
            'Only named functions can be called',
            expr.pos,
          );
        }
        const args: ASTNode[] = [];
        if (!this.check('PUNCT', ')')) {
          do {
            args.push(this.parseConditional());
          } while (this.match('PUNCT', ','));
        }
        this.consume('PUNCT', ')', "Expected ')' after function arguments");
        expr = {
          type: 'call',
          callee: expr.name,
          args,
          pos: expr.pos,
        };
      } else {
        break;
      }
    }

    return expr;
  }

  // 10. Primary: literals, identifiers, (expr)
  private parsePrimary(): ASTNode {
    const token = this.peek();

    if (this.match('NUMBER')) {
      const val = Number(token.value);
      if (Number.isNaN(val)) {
        throw new ExpressionSyntaxError(
          `Invalid number: ${token.value}`,
          token.pos,
        );
      }
      return { type: 'literal', value: val, pos: token.pos };
    }

    if (this.match('STRING')) {
      return { type: 'literal', value: token.value, pos: token.pos };
    }

    if (this.match('IDENT')) {
      if (token.value === 'true') {
        return { type: 'literal', value: true, pos: token.pos };
      }
      if (token.value === 'false') {
        return { type: 'literal', value: false, pos: token.pos };
      }
      if (token.value === 'null') {
        return { type: 'literal', value: null, pos: token.pos };
      }
      return { type: 'identifier', name: token.value, pos: token.pos };
    }

    if (this.match('PUNCT', '(')) {
      const expr = this.parseConditional();
      this.consume('PUNCT', ')', "Expected ')' after parenthesized expression");
      return expr;
    }

    throw new ExpressionSyntaxError(
      `Unexpected token '${token.value || token.type}'`,
      token.pos,
    );
  }
}

export function parse(input: string, maxLength = 1024): ASTNode {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new ExpressionSyntaxError('Empty expression', 0);
  }
  const tokens = tokenize(trimmed, maxLength);
  const parser = new Parser(tokens);
  return parser.parse();
}
