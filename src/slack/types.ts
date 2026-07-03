/**
 * Shared types for the Finn/shark Slack layer. Single source of truth for the
 * shapes every file under src/slack/ assumes — see FINN_DESIGN.md for the
 * design intent behind each of these.
 */
import type { Feedback } from '../types/index.js';

/** The three debating personas. Kept separate from src/types' PersonaName
 *  because this is Slack-presentation vocabulary (nameplates, reactions),
 *  not agent-runner vocabulary. */
export type SharkRole = 'support' | 'engineering' | 'product';

/** Finn's resolved read of one shark's argument (see emoji.ts). */
export type Stance = 'favored' | 'overruled' | 'unresolved';

/** What Finn proposes to do. Values are the vocabulary the Judge must
 *  produce and the verdict card renders a badge for. */
export type VerdictActionType =
  | 'create_jira'
  | 'create_zendesk'
  | 'dedup_link'
  | 'roadmap_reply'
  | 'no_action';

export interface VerdictAction {
  type: VerdictActionType;
  /** Human-readable one-liner, e.g. "File a Bug, high priority". */
  label: string;
  /** Whatever the executor needs to carry out this action (ticket body, Jira
   *  key to link, customer reply text, etc.) — shape varies by action type. */
  payload?: Record<string, unknown>;
}

/** Finn's final call on a debate. */
export interface Verdict {
  /** Stated as an outcome, e.g. "Dedup — this is issue #4821". */
  headline: string;
  /** 2-3 sentences a human approver can sanity-check at a glance. */
  rationale: string;
  /** Finn's resolved read of each shark's argument (drives 👍/👎/⚖️). */
  reads: Record<SharkRole, Stance>;
  action: VerdictAction;
}

/** One shark's turn in the debate thread, tracked so Finn can react to it
 *  during the debate and resolve that reaction once the judge decides. */
export interface SharkTurn {
  role: SharkRole;
  /** ts of the shark's posted message — reactions attach here. */
  messageTs: string;
  /** Set once the judge has resolved this shark's argument; absent while
   *  the debate is still in flight (thinkAbout has fired, resolve hasn't). */
  stance?: Stance;
}

/** A canned scenario card on Finn's App Home tab. This is deliberately a
 *  thin, presentation-only shape — the rich seed-data Scenario used to
 *  populate Zendesk/Jira/Slack lives in seed/scenarios.ts and is unrelated. */
export interface Scenario {
  id: string;
  title: string;
  /** One-line description shown under the title on the App Home card. */
  blurb: string;
}

/**
 * A unit of "the actual work" — the slow multi-agent debate/judge/execute
 * flow, as opposed to the fast Slack-request handling that dispatches it.
 *
 * Two ways this gets run (see src/slack/taskRunner.ts):
 *   - Socket Mode: the listener just calls runTask(...) directly and awaits
 *     it — the process stays alive for as long as it takes, no deadline.
 *   - Lambda: the receiver function acks Slack immediately, then hands the
 *     task off to a second, async-invoked Lambda (src/lambda/worker.ts) that
 *     calls the exact same runTask(...). This split exists because a Lambda
 *     execution environment can be frozen/reclaimed the instant the HTTP
 *     response is sent — you cannot "ack now, keep working after" in one
 *     invocation the way a long-lived process can.
 */
export type WorkTask =
  | { type: 'run_finn_flow'; feedback: Feedback }
  | { type: 'approve'; feedbackId: string; userId: string }
  | { type: 'reject'; feedbackId: string; userId: string }
  | { type: 'publish_home'; userId: string }
  | { type: 'run_scenario'; scenarioId: string }
  | { type: 'submit_feedback'; text: string; tier?: string };
