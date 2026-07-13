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

/**
 * A persona's structured conclusion, as submitted via the `submit_position`
 * output tool (see src/agents/outputTools.ts). This is the model handing us
 * typed JSON instead of headed free text we have to scrape — so it's immune to
 * per-model formatting quirks (markdown bold labels, reordered fields, etc.).
 */
export interface SharkPosition {
  /** 'act' | 'dont_act' | 'defer' — 'defer' renders the concession marker. */
  stance: string;
  confidence?: string;
  /** One line: what the persona thinks should happen. Becomes the card claim. */
  recommendation: string;
  /** Up to two evidence bullets, each with its source. */
  evidence: string[];
  agreement?: string;
}

/** The result of running a single persona agent to completion. */
export interface AgentResult {
  persona: PersonaName;
  /** The persona's final argued position (free text — a readable rendering of
   *  `structured` when the model used the output tool, kept for the judge brief
   *  and logs). */
  position: string;
  /** Evidence bullets the persona gathered (populated by tool use). */
  evidence: string[];
  /** Full record of tool calls, in order, for audit/debug. */
  toolCalls: ToolCallRecord[];
  /** The persona's typed conclusion when it used the `submit_position` output
   *  tool (the normal path against a real model). Absent only if the model
   *  ended with free text instead — callers fall back to scraping `position`. */
  structured?: SharkPosition;
}

// Note: `Verdict` used to live here. It's now in src/slack/types.ts (headline
// + reads + action.type), since it's Finn/shark presentation vocabulary, not
// agent-runner vocabulary — see FINN_DESIGN.md. Demo seed-data types
// (Scenario, SeedTicket, SeedJiraIssue) similarly moved to seed/scenarios.ts,
// which is deliberately self-contained.
