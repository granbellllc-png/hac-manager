import type { StepJournal, StepJournalEntry } from './types.js';

export class MemoryStepJournal implements StepJournal {
  private readonly entries = new Map<string, Map<number, StepJournalEntry>>();

  public async list(operationId: string): Promise<readonly StepJournalEntry[]> {
    return [...(this.entries.get(operationId)?.values() ?? [])].sort(
      (left, right) => left.stepIndex - right.stepIndex,
    );
  }

  public async save(entry: StepJournalEntry): Promise<void> {
    let operation = this.entries.get(entry.operationId);
    if (!operation) {
      operation = new Map<number, StepJournalEntry>();
      this.entries.set(entry.operationId, operation);
    }
    operation.set(entry.stepIndex, entry);
  }
}
