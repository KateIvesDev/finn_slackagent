/**
 * Shared types for the whole app. Import from here so the "shape" of the
 * system lives in one place. (In TS, `interface` and `type` are mostly
 * interchangeable — we use `interface` for object shapes and `type` for
 * unions/aliases, purely as a readability convention.)
 */

/** A piece of product feedback that landed in Slack and kicked off a run. */
export interface Feedback {
  /** Stable id for logging/idempotency (e.g. the Slack message ts). */
  id: string;
  /** The raw feedback text. */
  text: string;
  /** Slack channel id where it was posted. */
  channel: string;
  /** Message timestamp — also used as the thread root for replies. */
  threadTs: string;
  /** Slack user id who posted it (optional; webhooks may not have one). */
  user?: string;
  /** Permalink back to the source message, if we resolved one. */
  permalink?: string;
}

/** The three debating personas. */
export type PersonaName = 'support' | 'engineering' | 'product';

/** One tool call the agent made during a run — kept for transparency/debugging. */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
}

/** The result of running a single persona agent to completion. */
export interface AgentResult {
  persona: PersonaName;
  /** The persona's final argued position (free text). */
  position: string;
  /** Evidence bullets the persona gathered (populated by tool use). */
  evidence: string[];
  /** Full record of tool calls, in order, for audit/debug. */
  toolCalls: ToolCallRecord[];
}

// Note: `Verdict` used to live here. It's now in src/slack/types.ts (headline
// + reads + action.type), since it's Finn/shark presentation vocabulary, not
// agent-runner vocabulary — see FINN_DESIGN.md. Demo seed-data types
// (Scenario, SeedTicket, SeedJiraIssue) similarly moved to seed/scenarios.ts,
// which is deliberately self-contained.
