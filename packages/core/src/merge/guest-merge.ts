import type { Document } from 'yaml';
import { type ZodError } from 'zod';
import {
  type DeploymentDefaultsFile,
  type GuestDeployment,
  type GuestDeploymentFile,
  guestDeploymentSchema,
} from '../schema/deployment.js';
import {
  type FilemappingsFile,
  filemappingsFileSchema,
} from '../schema/filemappings.js';
import { mergeConfigs } from './merge.js';
import type { MergeResult, MergeSource, ProvenanceMap } from './types.js';

export class MergeValidationError extends Error {
  public constructor(
    message: string,
    public readonly zodError: ZodError,
    public readonly merged: unknown,
    public readonly provenance: ProvenanceMap,
  ) {
    super(message);
    this.name = 'MergeValidationError';
  }
}

export interface MergeGuestDeploymentOptions {
  readonly defaultDeployment?:
    | {
        readonly file: string;
        readonly data: DeploymentDefaultsFile;
        readonly document?: Document | undefined;
      }
    | undefined;
  readonly guestDeployment: {
    readonly file: string;
    readonly data: GuestDeploymentFile;
    readonly document?: Document | undefined;
  };
  readonly validate?: boolean | undefined;
}

export interface MergedGuestDeployment {
  readonly deployment: GuestDeployment;
  readonly provenance: ProvenanceMap;
}

export function mergeGuestDeployment(
  options: MergeGuestDeploymentOptions,
): MergedGuestDeployment {
  const defaultSource: MergeSource | undefined = options.defaultDeployment
    ? {
        file: options.defaultDeployment.file,
        layer: 'default',
        data: options.defaultDeployment.data,
        document: options.defaultDeployment.document,
      }
    : undefined;

  const overrideSource: MergeSource = {
    file: options.guestDeployment.file,
    layer: 'override',
    data: options.guestDeployment.data,
    document: options.guestDeployment.document,
  };

  const result: MergeResult = mergeConfigs(defaultSource, overrideSource, {
    identityMergedLists: ['network'],
  });

  const shouldValidate = options.validate ?? true;
  if (shouldValidate) {
    const parseResult = guestDeploymentSchema.safeParse(result.merged);
    if (!parseResult.success) {
      throw new MergeValidationError(
        `Merged guest deployment validation failed: ${parseResult.error.message}`,
        parseResult.error,
        result.merged,
        result.provenance,
      );
    }
    return {
      deployment: parseResult.data,
      provenance: result.provenance,
    };
  }

  return {
    deployment: result.merged as GuestDeployment,
    provenance: result.provenance,
  };
}

export interface MergeGuestFilemappingsOptions {
  readonly defaultFilemappings?:
    | {
        readonly file: string;
        readonly data: FilemappingsFile;
        readonly document?: Document | undefined;
      }
    | undefined;
  readonly guestFilemappings?:
    | {
        readonly file: string;
        readonly data: FilemappingsFile;
        readonly document?: Document | undefined;
      }
    | undefined;
  readonly validate?: boolean | undefined;
}

export interface MergedGuestFilemappings {
  readonly filemappings: FilemappingsFile;
  readonly provenance: ProvenanceMap;
}

export function mergeGuestFilemappings(
  options: MergeGuestFilemappingsOptions,
): MergedGuestFilemappings {
  const defaultSource: MergeSource | undefined = options.defaultFilemappings
    ? {
        file: options.defaultFilemappings.file,
        layer: 'default',
        data: options.defaultFilemappings.data,
        document: options.defaultFilemappings.document,
      }
    : undefined;

  const overrideSource: MergeSource | undefined = options.guestFilemappings
    ? {
        file: options.guestFilemappings.file,
        layer: 'override',
        data: options.guestFilemappings.data,
        document: options.guestFilemappings.document,
      }
    : undefined;

  const result: MergeResult = mergeConfigs(defaultSource, overrideSource);

  const shouldValidate = options.validate ?? true;
  if (shouldValidate) {
    const parseResult = filemappingsFileSchema.safeParse(result.merged);
    if (!parseResult.success) {
      throw new MergeValidationError(
        `Merged guest filemappings validation failed: ${parseResult.error.message}`,
        parseResult.error,
        result.merged,
        result.provenance,
      );
    }
    return {
      filemappings: parseResult.data,
      provenance: result.provenance,
    };
  }

  return {
    filemappings: result.merged as FilemappingsFile,
    provenance: result.provenance,
  };
}
