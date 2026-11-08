import { resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';

const pathSchema = z
  .string()
  .min(1)
  .transform((value) => resolve(value));
const booleanSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const envSchema = z
  .object({
    HACM_DATA_DIR: pathSchema,
    HACM_STATE_DIR: pathSchema,
    HACM_HOST: z.string().min(1).default('127.0.0.1'),
    HACM_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HACM_LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    HACM_WEB_DIR: z
      .string()
      .optional()
      .transform((value) => (value ? resolve(value) : undefined)),
    HACM_SECRET_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(86400)
      .default(300),
    HACM_HOST_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    HACM_SESSION_SECRET: z.string().min(32).optional(),
    HACM_SECRET_KEY: z.string().min(32).optional(),
    HACM_COOKIE_SECURE: booleanSchema.default(true),
    HACM_PROTECTED_HOST_ID: z.string().optional(),
    HACM_PROTECTED_GUEST_ID: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.coerce.number().int().min(100).optional(),
    ),
  })
  .superRefine((config, context) => {
    const stateRelative = relative(config.HACM_DATA_DIR, config.HACM_STATE_DIR);
    if (
      stateRelative === '' ||
      (!stateRelative.startsWith('..') && !isAbsolute(stateRelative))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['HACM_STATE_DIR'],
        message: 'State dir must be outside the data dir.',
      });
    }
  });

export type ServerConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Report schema diagnostics only; environment values may contain credentials.
    throw new Error(
      `Invalid HACM configuration:\n${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')}`,
    );
  }
  return result.data;
}
