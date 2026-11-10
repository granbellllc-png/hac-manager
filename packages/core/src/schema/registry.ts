import type { z } from 'zod';
import {
  deploymentDefaultsFileSchema,
  guestDeploymentFileSchema,
} from './deployment.js';
import { envFileSchema } from './env.js';
import { filemappingsFileSchema } from './filemappings.js';
import { hostFileSchema } from './host.js';
import { secretsFileSchema } from './secrets.js';
import { tasksFileSchema } from './tasks.js';

/** Every config file kind HAC Manager reads from the data dir. */
export const configSchemas = {
  host: hostFileSchema,
  deployment: guestDeploymentFileSchema,
  'deployment-defaults': deploymentDefaultsFileSchema,
  filemappings: filemappingsFileSchema,
  env: envFileSchema,
  tasks: tasksFileSchema,
  secrets: secretsFileSchema,
} as const;

export type ConfigKind = keyof typeof configSchemas;
export const configKinds = Object.keys(configSchemas) as ConfigKind[];
export type ConfigOf<K extends ConfigKind> = z.infer<(typeof configSchemas)[K]>;

/** Conventional file name for each kind, used for editor associations. */
export const configFileGlobs: Readonly<Record<ConfigKind, string>> = {
  host: 'hosts/*/host.yaml',
  deployment: 'hosts/*/*/deployment.yaml',
  'deployment-defaults': 'hosts/*/default-deployment.yaml',
  filemappings: 'hosts/*/{default-filemappings.yaml,*/filemappings.yaml}',
  env: 'hosts/*/*/.env.yaml',
  tasks: '{global-tasks,hosts/*/tasks,hosts/*/*/tasks}/*.yaml',
  secrets: 'secrets.yaml',
};
