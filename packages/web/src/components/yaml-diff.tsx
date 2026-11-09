export interface LineDiff {
  readonly kind: 'context' | 'added' | 'removed';
  readonly text: string;
}

const maxDiffCells = 100_000;

export function buildLineDiff(
  before: string,
  after: string,
): readonly LineDiff[] {
  const left = before.replace(/\r\n/g, '\n').split('\n');
  const right = after.replace(/\r\n/g, '\n').split('\n');

  if (left.length * right.length > maxDiffCells) {
    return [
      ...left.map((text) => ({ kind: 'removed' as const, text })),
      ...right.map((text) => ({ kind: 'added' as const, text })),
    ];
  }

  const lengths = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex--) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex--) {
      lengths[leftIndex]![rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? lengths[leftIndex + 1]![rightIndex + 1]! + 1
          : Math.max(
              lengths[leftIndex + 1]![rightIndex]!,
              lengths[leftIndex]![rightIndex + 1]!,
            );
    }
  }

  const result: LineDiff[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      result.push({ kind: 'context', text: left[leftIndex]! });
      leftIndex++;
      rightIndex++;
    } else if (
      lengths[leftIndex + 1]![rightIndex]! >=
      lengths[leftIndex]![rightIndex + 1]!
    ) {
      result.push({ kind: 'removed', text: left[leftIndex]! });
      leftIndex++;
    } else {
      result.push({ kind: 'added', text: right[rightIndex]! });
      rightIndex++;
    }
  }
  while (leftIndex < left.length) {
    result.push({ kind: 'removed', text: left[leftIndex++]! });
  }
  while (rightIndex < right.length) {
    result.push({ kind: 'added', text: right[rightIndex++]! });
  }
  return result;
}

export function YamlDiff({
  before,
  after,
}: {
  readonly before: string;
  readonly after: string;
}) {
  const lines = buildLineDiff(before, after);
  return (
    <div
      className="max-h-[32rem] overflow-auto rounded-md border bg-muted font-mono text-xs"
      data-testid="yaml-diff"
    >
      {lines.map((line, index) => (
        <div
          key={`${index}:${line.kind}`}
          className={
            line.kind === 'added'
              ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
              : line.kind === 'removed'
                ? 'bg-rose-500/10 text-rose-800 dark:text-rose-300'
                : 'text-muted-foreground'
          }
        >
          <span className="inline-block w-7 px-2 text-right select-none">
            {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
          </span>
          <span className="whitespace-pre-wrap">{line.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}
