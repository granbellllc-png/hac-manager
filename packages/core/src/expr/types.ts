export interface HostContext {
  readonly id?: string | undefined;
  readonly index?: number | undefined;
  readonly name?: string | undefined;
  readonly [key: string]: unknown;
}

export interface GuestContext {
  readonly id?: number | undefined;
  readonly name?: string | undefined;
  readonly type?: 'lxc' | 'vm' | undefined;
  readonly [key: string]: unknown;
}

export interface NetContext {
  readonly index?: number | undefined;
  readonly name?: string | undefined;
  readonly bridge?: string | undefined;
  readonly [key: string]: unknown;
}

export interface EvaluationContext {
  readonly host?: HostContext | undefined;
  readonly guest?: GuestContext | undefined;
  readonly net?: NetContext | undefined;
  readonly vmid?: number | undefined;
  readonly [key: string]: unknown;
}

export interface EvaluationLimits {
  readonly maxExpressionLength?: number | undefined;
  readonly maxSteps?: number | undefined;
  readonly maxDepth?: number | undefined;
}

export class ExpressionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

export class ExpressionSyntaxError extends ExpressionError {
  public constructor(
    message: string,
    public readonly position: number,
  ) {
    super(`${message} at position ${position}`);
    this.name = 'ExpressionSyntaxError';
  }
}

export class ExpressionSecurityError extends ExpressionError {
  public constructor(message: string) {
    super(`Security violation in expression: ${message}`);
    this.name = 'ExpressionSecurityError';
  }
}

export class ExpressionLimitError extends ExpressionError {
  public constructor(message: string) {
    super(`Resource limit exceeded in expression: ${message}`);
    this.name = 'ExpressionLimitError';
  }
}

export class MacRangeError extends ExpressionError {
  public constructor(message: string) {
    super(`MAC address scheme range error: ${message}`);
    this.name = 'MacRangeError';
  }
}
