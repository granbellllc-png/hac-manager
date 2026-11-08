import { type ASTNode } from './ast.js';
import { Evaluator, type EvaluateOptions } from './evaluator.js';
import { parse } from './parser.js';
import { type EvaluationContext } from './types.js';

export * from './types.js';
export * from './helpers.js';
export * from './ast.js';
export { parse, tokenize } from './parser.js';
export { Evaluator, type EvaluateOptions } from './evaluator.js';

export function evaluateExpression(
  expression: string,
  context: EvaluationContext = {},
  options?: EvaluateOptions,
): unknown {
  const ast: ASTNode = parse(
    expression,
    options?.limits?.maxExpressionLength ?? 1024,
  );
  const evaluator = new Evaluator(context, options);
  return evaluator.evaluate(ast);
}
