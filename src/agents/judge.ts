/**
 * The Judge agent — this is "Finn" (see FINN_DESIGN.md). Reads the three
 * grounded shark positions and produces a single Verdict: headline, per-shark
 * read (drives the 👍/👎/⚖️ reaction resolution), and one proposed action.
 *
 * The judge has NO tools — it only reasons over the positions the sharks
 * already gathered. It uses the same Bedrock client (stubbed for now).
 */
import { converse } from '../bedrock/client.js';
import { judgePrompt } from './personas.js';
import type { AgentResult } from '../types/index.js';
import type { Verdict, SharkRole, Stance, VerdictActionType } from '../slack/types.js';
import type { SharkArgument } from '../slack/sharks.js';

export async function runJudge(positions: AgentResult[]): Promise<Verdict> {
  // Assemble the sharks' arguments into a single prompt for the judge.
  const brief = positions
    .map((p) => `## ${p.persona.toUpperCase()}\n${p.position}\n\nEvidence:\n- ${p.evidence.join('\n- ')}`)
    .join('\n\n');

  const response = await converse({
    system: [{ text: judgePrompt }],
    messages: [{ role: 'user', content: [{ text: brief }] }],
    tools: [], // judge decides, it doesn't act
  });

  const text =
    response.output?.message?.content?.find((c) => 'text' in c && c.text)?.[
      'text' as never
    ] ?? '';

  return parseVerdict(String(text));
}

const ACTION_TYPES: VerdictActionType[] = [
  'create_jira',
  'dedup_link',
  'create_zendesk',
  'roadmap_reply',
  'no_action',
];
const STANCES: Stance[] = ['favored', 'overruled', 'unresolved'];
const ROLES: SharkRole[] = ['support', 'engineering', 'product'];

/** Pull `KEY: value` out of the judge's structured text response (see the
 *  response shape spelled out at the end of JUDGE_PROMPT in personas.ts). */
function field(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim();
}

/**
 * Parse the judge's real structured output into a Verdict. Falls back to a
 * clearly-labeled stub verdict when the expected fields aren't present — which
 * is exactly what happens while Bedrock is stubbed (BEDROCK_STUB=true), since
 * the canned echo text in src/bedrock/client.ts doesn't follow this format.
 *
 * TODO: once real model calls are flowing (BEDROCK_STUB=false), sanity-check
 * this against a few live judge outputs — free-text models don't always
 * follow a requested shape perfectly, so consider forcing this via a
 * tool-call/JSON response instead of scraping headed plain text.
 */
function parseVerdict(judgeText: string): Verdict {
  const actionRaw = field(judgeText, 'ACTION')?.toLowerCase().trim();
  const action = ACTION_TYPES.find((a) => a === actionRaw);

  if (!action) {
    return stubVerdict(judgeText);
  }

  const headline = field(judgeText, 'HEADLINE') ?? 'Finn has a call';
  const rationale = field(judgeText, 'RATIONALE') ?? judgeText.slice(0, 300);
  const details = field(judgeText, 'DETAILS');
  const customerReply = field(judgeText, 'CUSTOMER REPLY');

  const reads = parseReads(judgeText);

  const ACTION_LABEL: Record<VerdictActionType, string> = {
    create_jira: 'Create Jira issue',
    dedup_link: 'Link to existing Jira issue',
    create_zendesk: 'Create Zendesk ticket',
    roadmap_reply: 'Roadmap reply, no ticket',
    no_action: 'No action',
  };

  // A Jira key mention in DETAILS (e.g. "link to CAL-1487") — only meaningful
  // for dedup_link, but harmless to parse unconditionally.
  const jiraKeyToLink = details?.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];

  return {
    headline,
    rationale,
    reads,
    action: {
      type: action,
      label: details ?? ACTION_LABEL[action],
      // Consistent payload keys whether this came from a real parse or the
      // stub fallback below, so src/agents/executor.ts has one shape to read.
      payload: {
        title: headline,
        body: rationale,
        issueType: action === 'create_jira' ? 'Bug' : undefined,
        jiraKeyToLink: action === 'dedup_link' ? jiraKeyToLink : undefined,
        customerReply: customerReply && customerReply !== 'n/a' ? customerReply : undefined,
        details,
      },
    },
  };
}

/**
 * Turn one shark's free-text position (the STANCE/CONFIDENCE/RECOMMENDATION/
 * EVIDENCE/AGREEMENT shape from DEBATE_PRINCIPLES in personas.ts) into the
 * compact SharkArgument the Block Kit panel renders. Falls back to the raw
 * evidence/first line when the expected fields aren't present (e.g. while
 * Bedrock is stubbed and the position text doesn't follow this format).
 */
export function parseSharkArgument(result: AgentResult): SharkArgument {
  const text = result.position;
  const stance = field(text, 'STANCE');
  const recommendation = field(text, 'RECOMMENDATION');
  const evidenceBlock = text.match(/EVIDENCE:\s*([\s\S]*?)(?:\n[A-Z ]+:|$)/)?.[1] ?? '';
  const evidence = evidenceBlock
    .split('\n')
    .map((line) => line.replace(/^-+\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 2);

  return {
    claim: recommendation ?? text.split('\n')[0]?.trim() ?? text.slice(0, 200),
    evidence: evidence.length ? evidence : result.evidence.slice(0, 2),
    conceded: stance?.toUpperCase().includes('DEFER') ?? false,
  };
}

/** Parse the `READS:` block (one `- support: favored` style line per shark).
 *  Defaults anything missing/unparsed to 'unresolved' rather than guessing. */
function parseReads(text: string): Record<SharkRole, Stance> {
  const reads = {} as Record<SharkRole, Stance>;
  for (const role of ROLES) {
    const match = text.match(new RegExp(`^-\\s*${role}:\\s*(\\w+)`, 'im'));
    const stance = STANCES.find((s) => s === match?.[1]?.toLowerCase());
    reads[role] = stance ?? 'unresolved';
  }
  return reads;
}

/** Deterministic fallback so the round-trip (and the Slack card / reaction
 *  arc) is exercisable even while Bedrock is stubbed and produces no
 *  structured ACTION line to parse. */
function stubVerdict(judgeText: string): Verdict {
  return {
    headline: 'STUB verdict — file a Bug',
    rationale:
      'STUB verdict: multiple customers reported the same bug and no matching Jira issue exists, so file a new bug. ' +
      `(judge said: ${judgeText.slice(0, 120)}...)`,
    reads: { support: 'favored', engineering: 'favored', product: 'unresolved' },
    action: {
      type: 'create_jira',
      label: 'Create Jira issue',
      payload: {
        title: 'Bug: <summarised from feedback>',
        body: 'Repro / impact summary goes here.',
        issueType: 'Bug',
        jiraKeyToLink: undefined,
        customerReply: undefined,
      },
    },
  };
}
