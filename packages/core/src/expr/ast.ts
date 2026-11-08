export type ASTNode =
  | LiteralNode
  | IdentifierNode
  | MemberNode
  | CallNode
  | UnaryNode
  | BinaryNode
  | ConditionalNode;

export interface LiteralNode {
  readonly type: 'literal';
  readonly value: unknown;
  readonly pos: number;
}

export interface IdentifierNode {
  readonly type: 'identifier';
  readonly name: string;
  readonly pos: number;
}

export interface MemberNode {
  readonly type: 'member';
  readonly object: ASTNode;
  readonly property: string | ASTNode;
  readonly computed: boolean;
  readonly pos: number;
}

export interface CallNode {
  readonly type: 'call';
  readonly callee: string;
  readonly args: readonly ASTNode[];
  readonly pos: number;
}

export interface UnaryNode {
  readonly type: 'unary';
  readonly op: '!' | '-' | '+';
  readonly operand: ASTNode;
  readonly pos: number;
}

export interface BinaryNode {
  readonly type: 'binary';
  readonly op:
    | '+'
    | '-'
    | '*'
    | '/'
    | '%'
    | '=='
    | '!='
    | '<'
    | '<='
    | '>'
    | '>='
    | '&&'
    | '||';
  readonly left: ASTNode;
  readonly right: ASTNode;
  readonly pos: number;
}

export interface ConditionalNode {
  readonly type: 'conditional';
  readonly test: ASTNode;
  readonly consequent: ASTNode;
  readonly alternate: ASTNode;
  readonly pos: number;
}
