import type { ASTNode } from './ast.js';
import { builtInHelpers } from './helpers.js';
import {
  type EvaluationContext,
  type EvaluationLimits,
  ExpressionError,
  ExpressionLimitError,
  ExpressionSecurityError,
} from './types.js';

const forbiddenProperties = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

const forbiddenGlobals = new Set([
  'window',
  'global',
  'globalThis',
  'process',
  'require',
  'module',
  'Function',
  'eval',
  'constructor',
  '__proto__',
]);

export interface EvaluateOptions {
  readonly helpers?:
    Record<string, (...args: unknown[]) => unknown> | undefined;
  readonly limits?: EvaluationLimits | undefined;
}

export class Evaluator {
  private steps = 0;
  private depth = 0;
  private readonly maxSteps: number;
  private readonly maxDepth: number;
  private readonly helpers: Record<string, (...args: unknown[]) => unknown>;

  public constructor(
    private readonly context: EvaluationContext,
    options: EvaluateOptions = {},
  ) {
    this.maxSteps = options.limits?.maxSteps ?? 1000;
    this.maxDepth = options.limits?.maxDepth ?? 30;
    this.helpers = {
      ...builtInHelpers,
      ...(options.helpers ?? {}),
    };
  }

  public evaluate(node: ASTNode): unknown {
    this.steps++;
    if (this.steps > this.maxSteps) {
      throw new ExpressionLimitError(
        `Maximum step limit (${this.maxSteps}) exceeded during expression evaluation`,
      );
    }

    this.depth++;
    if (this.depth > this.maxDepth) {
      throw new ExpressionLimitError(
        `Maximum expression depth (${this.maxDepth}) exceeded`,
      );
    }

    try {
      switch (node.type) {
        case 'literal':
          return node.value;

        case 'identifier': {
          if (forbiddenGlobals.has(node.name)) {
            throw new ExpressionSecurityError(
              `Access to global/system identifier '${node.name}' is prohibited`,
            );
          }
          if (Object.prototype.hasOwnProperty.call(this.context, node.name)) {
            return this.context[node.name];
          }
          return undefined;
        }

        case 'member': {
          const obj = this.evaluate(node.object);
          let prop: string;
          if (node.computed) {
            const evaluatedProp = this.evaluate(node.property as ASTNode);
            prop = String(evaluatedProp);
          } else {
            prop = node.property as string;
          }

          if (forbiddenProperties.has(prop)) {
            throw new ExpressionSecurityError(
              `Access to property '${prop}' is prohibited`,
            );
          }

          if (obj === null || obj === undefined) {
            return undefined;
          }

          if (
            typeof obj === 'object' ||
            typeof obj === 'string' ||
            Array.isArray(obj)
          ) {
            return (obj as Record<string, unknown>)[prop];
          }

          return undefined;
        }

        case 'call': {
          if (
            forbiddenProperties.has(node.callee) ||
            forbiddenGlobals.has(node.callee)
          ) {
            throw new ExpressionSecurityError(
              `Calling function '${node.callee}' is prohibited`,
            );
          }

          if (
            !Object.prototype.hasOwnProperty.call(this.helpers, node.callee)
          ) {
            throw new ExpressionError(`Unknown function: '${node.callee}'`);
          }

          const fn = this.helpers[node.callee]!;
          const args = node.args.map((arg) => this.evaluate(arg));
          return fn(...args);
        }

        case 'unary': {
          const val = this.evaluate(node.operand);
          switch (node.op) {
            case '!':
              return !val;
            case '-':
              return -Number(val);
            case '+':
              return +Number(val);
          }
          break;
        }

        case 'binary': {
          // Short-circuit logical operators
          if (node.op === '&&') {
            const leftVal = this.evaluate(node.left);
            return leftVal ? this.evaluate(node.right) : leftVal;
          }
          if (node.op === '||') {
            const leftVal = this.evaluate(node.left);
            return leftVal ? leftVal : this.evaluate(node.right);
          }

          const left = this.evaluate(node.left);
          const right = this.evaluate(node.right);

          switch (node.op) {
            case '+':
              if (typeof left === 'string' || typeof right === 'string') {
                return String(left ?? '') + String(right ?? '');
              }
              return Number(left) + Number(right);
            case '-':
              return Number(left) - Number(right);
            case '*':
              return Number(left) * Number(right);
            case '/':
              if (Number(right) === 0) {
                throw new ExpressionError('Division by zero');
              }
              return Number(left) / Number(right);
            case '%':
              if (Number(right) === 0) {
                throw new ExpressionError('Modulo by zero');
              }
              return Number(left) % Number(right);
            case '==':
              return left === right;
            case '!=':
              return left !== right;
            case '<':
              return (left as number) < (right as number);
            case '<=':
              return (left as number) <= (right as number);
            case '>':
              return (left as number) > (right as number);
            case '>=':
              return (left as number) >= (right as number);
          }
          break;
        }

        case 'conditional': {
          const testVal = this.evaluate(node.test);
          return testVal
            ? this.evaluate(node.consequent)
            : this.evaluate(node.alternate);
        }
      }
    } finally {
      this.depth--;
    }
  }
}
