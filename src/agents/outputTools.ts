/**
 * Output tools — how the agents hand us STRUCTURED results instead of headed
 * free text we have to regex-scrape.
 *
 * The old design asked each persona/judge to emit a `LABEL: value` shape and
 * parsed it with regexes in judge.ts. That was brittle across models: Claude
 * bolds the labels (`**STANCE:**`), a model may reorder fields or add prose,
 * and any miss silently fell back to a stub verdict. Instead we give the model
 * a tool whose `inputSchema` IS the result shape; the model "calls" it with
 * typed JSON args and we read those directly — schema-constrained, no scraping.
 *
 * - Sharks get `submit_position` as a SENTINEL tool: not forced (they must use
 *   their real evidence tools first), so the prompt instructs them to call it
 *   to conclude. runAgent intercepts the call and returns its args.
 * - The Judge gets `submit_verdict` and we FORCE it via toolChoice — a single
 *   call that must return the verdict as typed args.
 *
 * These tools never mutate anything; `execute` is a passthrough that only runs
 * in the (unforced, shark) case where we choose not to intercept. The real read
 * happens off the `toolUse.input` block in runAgent / runJudge.
 */
import { defineTool } from '../tools/registry.js';
import type { VerdictActionType, Stance, SharkRole } from '../slack/types.js';

/** Tool names, referenced in runAgent (sentinel) and judge (forced choice). */
export const SUBMIT_POSITION = 'submit_position';
export const SUBMIT_VERDICT = 'submit_verdict';

// ---------------------------------------------------------------------------
// Shark position — the typed form of the old STANCE/RECOMMENDATION/EVIDENCE text.
// ---------------------------------------------------------------------------

/** Raw args shape the model fills in when it calls submit_position. Mirrors
 *  SharkPosition (src/types) — kept here since it's the tool's I/O contract. */
export interface SubmitPositionInput {
  stance: 'act' | 'dont_act' | 'defer';
  confidence?: 'low' | 'medium' | 'high';
  recommendation: string;
  evidence: string[];
  agreement?: string;
}

export const submitPositionTool = defineTool<SubmitPositionInput, SubmitPositionInput>({
  name: SUBMIT_POSITION,
  description:
    'Submit your final position on the feedback once you have gathered evidence. ' +
    'Call this exactly once, at the end, instead of writing a prose answer.',
  inputSchema: {
    type: 'object',
    properties: {
      stance: {
        type: 'string',
        enum: ['act', 'dont_act', 'defer'],
        description: "'act' to do something, 'dont_act' to decline, 'defer' to defer to the other panelists",
      },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      recommendation: {
        type: 'string',
        description: 'One line: what you think should happen. This is shown as your claim on the panel.',
      },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 2,
        description:
          'Up to TWO evidence bullets, each with its source (e.g. "5 Zendesk tickets in 3 days, 3 orgs", ' +
          '"KALA-980 is a Backlog Story, low severity"). Lead with your strongest. Two bullets should cover ' +
          'different ground — omit the second rather than pad.',
      },
      agreement: {
        type: 'string',
        description: 'One line: do you expect to agree with the others here, and why/why not.',
      },
    },
    required: ['stance', 'recommendation', 'evidence'],
  },
  // Only reached if a caller leaves it unforced AND doesn't intercept — a no-op
  // echo. runAgent intercepts the call before this runs.
  execute: async (input) => input,
});

// ---------------------------------------------------------------------------
// Judge verdict — the typed form of the old HEADLINE/ACTION/READS/... text.
// ---------------------------------------------------------------------------

/** Raw args shape the model fills in when it calls submit_verdict. Maps almost
 *  1:1 onto the Verdict (src/slack/types.ts); judge.ts assembles the final. */
export interface SubmitVerdictInput {
  headline: string;
  action: VerdictActionType;
  rationale: string;
  consensus?: string;
  /** Axis of disagreement, or "none" when it's a clean consensus. */
  tension?: string;
  decidingFactor?: string;
  reads: Record<SharkRole, Stance>;
  /** Priority, issue type, Jira key to link, routing — whatever the action needs. */
  details?: string;
  /** The message to send back to the customer, if any. */
  customerReply?: string;
}

const STANCE_ENUM: Stance[] = ['favored', 'overruled', 'unresolved'];
const ACTION_ENUM: VerdictActionType[] = [
  'create_jira',
  'dedup_link',
  'create_zendesk',
  'roadmap_reply',
  'no_action',
];

export const submitVerdictTool = defineTool<SubmitVerdictInput, SubmitVerdictInput>({
  name: SUBMIT_VERDICT,
  description: 'Submit your final verdict on the feedback. Call this exactly once.',
  inputSchema: {
    type: 'object',
    properties: {
      headline: {
        type: 'string',
        description:
          'Your call as an outcome, mapped to your action — e.g. "File it — new high-priority bug", ' +
          '"Dedup — this is KALA-1487", "Escalate to the account\'s CSM", "Roadmap reply — no ticket".',
      },
      action: {
        type: 'string',
        enum: ACTION_ENUM,
        description: 'Exactly one action to propose.',
      },
      rationale: {
        type: 'string',
        description:
          '2-3 sentences for the human approver: the situation and what you\'re doing about it — the fuller ' +
          'picture, NOT a restatement of the deciding factor.',
      },
      consensus: { type: 'string', description: 'Where the three agreed, one line.' },
      tension: {
        type: 'string',
        description: 'The axis of disagreement in a few words, or "none" on a clean consensus.',
      },
      decidingFactor: {
        type: 'string',
        description: 'The single fact that tipped it — one clause, distinct from the rationale.',
      },
      reads: {
        type: 'object',
        description: 'How each shark\'s argument weighs into your call.',
        properties: {
          support: { type: 'string', enum: STANCE_ENUM },
          engineering: { type: 'string', enum: STANCE_ENUM },
          product: { type: 'string', enum: STANCE_ENUM },
        },
        required: ['support', 'engineering', 'product'],
      },
      details: {
        type: 'string',
        description: 'Priority, issue type, Jira key to link, CSM/account routing — whatever the action needs.',
      },
      customerReply: {
        type: 'string',
        description: 'The message to send back to the customer, if any — else omit.',
      },
    },
    required: ['headline', 'action', 'rationale', 'reads'],
  },
  execute: async (input) => input,
});
