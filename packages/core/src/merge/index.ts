export {
  type Layer,
  type MergeOptions,
  type MergeResult,
  type MergeSource,
  type ProvenanceEntry,
  type ProvenanceMap,
  type RemovedKeyEntry,
} from './types.js';
export { DefaultProvenanceMap } from './provenance-map.js';
export { mergeConfigs } from './merge.js';
export {
  mergeGuestDeployment,
  mergeGuestFilemappings,
  MergeValidationError,
  type MergeGuestDeploymentOptions,
  type MergedGuestDeployment,
  type MergeGuestFilemappingsOptions,
  type MergedGuestFilemappings,
} from './guest-merge.js';
