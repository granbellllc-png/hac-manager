export { toErrorMessage } from './errors.js';

export const projectName = 'HAC Manager';
export const guestTypes = ['lxc', 'vm'] as const;
export type GuestType = (typeof guestTypes)[number];

export function isGuestType(value: unknown): value is GuestType {
  return guestTypes.some((type) => type === value);
}

export {
  TransportAbortedError,
  TransportFileNotFoundError,
  type ExecOptions,
  type ExecResult,
  type OutputStream,
  type Transport,
} from './transport/types.js';
export {
  runMutation,
  type ExecutorContext,
  type MutationOutcome,
} from './transport/dry-run.js';
export {
  FakeTransport,
  type CommandMatcher,
  type FakeResponse,
  type RecordedCall,
  type RecordedExec,
  type RecordedFileOp,
} from './transport/fake.js';
export {
  RecordingTransport,
  type RecordedExecution,
  type Sanitizer,
} from './transport/recording.js';
export * from './schema/index.js';
export * from './yaml/index.js';
export * from './data-dir/index.js';
export * from './merge/index.js';
export * from './expr/index.js';
export * from './tags/index.js';
export * from './validate/index.js';
export * from './writeback/index.js';
export * from './secrets/index.js';
export * from './redaction/index.js';
export * from './codec/index.js';
export * from './importer/index.js';
export * from './steps/index.js';
export * from './plans/index.js';
export * from './guest/index.js';
export * from './provision/index.js';
export * from './storage/index.js';
export * from './filemappings/index.js';
export * from './env/index.js';
export * from './community-scripts/index.js';
export * from './tasks/index.js';
export * from './drift/index.js';
