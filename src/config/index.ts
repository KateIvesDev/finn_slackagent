/**
 * Centralised, typed config. Everything reads env through this module so we
 * validate once at startup and get autocomplete everywhere else.
 *
 * We use zod to parse `process.env`. If a required var is missing, the app
 * fails fast with a readable error instead of `undefined` blowing up deep in a
 * request handler.
 */
import 'dotenv/config'; // side-effect import: loads .env into process.env
import { z } from 'zod';

// Unlike a missing key in `.env` (which Node never sets, so
// `process.env.X` is `undefined`), Terraform's Lambda `environment.variables`
// block always sets the key — a blank tfvar becomes an empty string, not an
// absent var. Treat "" the same as unset before the .url() check, or a
// deliberately-blank optional URL fails validation on deploy.
const optionalUrl = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().url().optional(),
);

// Mark vars optional here when a given entrypoint doesn't need them — e.g. the
// local orchestrator script doesn't need Slack tokens. We validate lazily per
// concern (see `loadConfig`) rather than forcing everything to be present.
const schema = z.object({
  // Slack
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_FEEDBACK_CHANNEL: z.string().optional(),

  // AWS / Bedrock
  AWS_REGION: z.string().default('us-east-1'),
  BEDROCK_MODEL_ID: z.string().optional(),

  // MCP
  ZENDESK_MCP_URL: optionalUrl,
  SLACK_MCP_URL: optionalUrl,

  // Zendesk sandbox (seeding)
  ZENDESK_SUBDOMAIN: z.string().optional(),
  ZENDESK_EMAIL: z.string().optional(),
  ZENDESK_API_TOKEN: z.string().optional(),

  // Jira sandbox (seeding)
  JIRA_BASE_URL: optionalUrl,
  JIRA_EMAIL: z.string().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  JIRA_PROJECT_KEY: z.string().default('DEMO'),
});

/** Parsed config type, inferred from the schema. */
export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

/** Parse + cache env once. Throws with a clear message on bad/missing vars. */
export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Flatten zod errors into something readable in a terminal.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Assert that a set of keys are present (non-empty). Call this at the top of an
 * entrypoint that actually needs them, e.g. the Slack app requires the Slack
 * tokens but the local runner does not.
 */
export function requireConfig<K extends keyof Config>(keys: K[]): void {
  const cfg = loadConfig();
  const missing = keys.filter((k) => !cfg[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. See .env.example.`,
    );
  }
}
