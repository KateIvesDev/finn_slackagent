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
import { submitVerdictTool, SUBMIT_VERDICT } from './outputTools.js';
import type { SubmitVerdictInput } from './outputTools.js';
import type { AgentResult } from '../types/index.js';
import type { Verdict, SharkRole, Stance, VerdictActionType } from '../slack/types.js';
import type { SharkArgument } from '../slack/sharks.js';

export async function runJudge(positions: AgentResult[]): Promise<Verdict> {
  // Assemble the sharks' arguments into a single prompt for the judge.
  const brief = positions
    .map((p) => `## ${p.persona.toUpperCase()}\n${p.position}\n\nEvidence:\n- ${p.evidence.join('\n- ')}`)
    .join('\n\n');

  // FORCE the judge to answer by calling submit_verdict — a single tool call
  // whose typed args ARE the verdict. No text to scrape, so it's immune to
  // per-model formatting (the markdown-bold-label bug that broke the old
  // headed-text parser). See outputTools.ts.
  const response = await converse({
    system: [{ text: judgePrompt }],
    messages: [{ role: 'user', content: [{ text: brief }] }],
    tools: [submitVerdictTool],
    toolChoice: { tool: { name: SUBMIT_VERDICT } },
  });

  const content = response.output?.message?.content ?? [];
  const verdictInput = content
    .map((c) => ('toolUse' in c && c.toolUse?.name === SUBMIT_VERDICT ? c.toolUse.input : undefined))
    .find((v): v is NonNullable<typeof v> => v !== undefined) as SubmitVerdictInput | undefined;

  if (verdictInput) return verdictFromInput(verdictInput);

  // Fallback: the model somehow answered with prose instead of the forced tool
  // (rare). Scrape any text the old way rather than crash.
  const text = content.find((c) => 'text' in c && c.text)?.['text' as never] ?? '';
  return parseVerdict(String(text));
}

/** Human-readable action labels, shared by the tool-path and text-fallback. */
const ACTION_LABEL: Record<VerdictActionType, string> = {
  create_jira: 'Create Jira issue',
  dedup_link: 'Link to existing Jira issue',
  create_zendesk: 'Create Zendesk ticket',
  roadmap_reply: 'Roadmap reply, no ticket',
  no_action: 'No action',
};

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
  const consensus = field(judgeText, 'CONSENSUS');
  // The prompt tells the Judge to write "none" when there's no real tension —
  // only surface this when it's an actual tradeoff worth a human's attention.
  const tensionRaw = field(judgeText, 'TENSION');
  const tension = tensionRaw && tensionRaw.toLowerCase() !== 'none' ? tensionRaw : undefined;
  const decidingFactor = field(judgeText, 'DECIDING FACTOR');

  const reads = parseReads(judgeText);

  // A Jira key mention in DETAILS (e.g. "link to KALA-1487") — only meaningful
  // for dedup_link, but harmless to parse unconditionally.
  const jiraKeyToLink = details?.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];

  return {
    headline,
    rationale,
    consensus,
    tension,
    decidingFactor,
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
 * Assemble a Verdict from the judge's typed submit_verdict args (the normal
 * path). This is where all the model output flows now — no scraping. Mirrors
 * parseVerdict's assembly so the executor sees one payload shape either way.
 */
function verdictFromInput(input: SubmitVerdictInput): Verdict {
  const action = ACTION_TYPES.find((a) => a === input.action) ?? 'no_action';
  const details = input.details?.trim() || undefined;
  // "none" means no real tradeoff — only surface a tension when there is one.
  const tension =
    input.tension && input.tension.toLowerCase() !== 'none' ? input.tension.trim() : undefined;
  const customerReply =
    input.customerReply && input.customerReply.toLowerCase() !== 'n/a'
      ? input.customerReply
      : undefined;
  const jiraKeyToLink = details?.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];

  return {
    headline: input.headline?.trim() || 'Finn has a call',
    rationale: input.rationale?.trim() || '',
    consensus: input.consensus?.trim() || undefined,
    tension,
    decidingFactor: input.decidingFactor?.trim() || undefined,
    reads: normalizeReads(input.reads),
    action: {
      type: action,
      label: details ?? ACTION_LABEL[action],
      payload: {
        title: input.headline,
        body: input.rationale,
        issueType: action === 'create_jira' ? 'Bug' : undefined,
        jiraKeyToLink: action === 'dedup_link' ? jiraKeyToLink : undefined,
        customerReply,
        details,
      },
    },
  };
}

/** Validate the per-shark reads from tool args, defaulting anything
 *  missing/unexpected to 'unresolved' rather than trusting raw model output. */
function normalizeReads(raw: Partial<Record<SharkRole, string>> | undefined): Record<SharkRole, Stance> {
  const reads = {} as Record<SharkRole, Stance>;
  for (const role of ROLES) {
    const val = raw?.[role]?.toLowerCase();
    reads[role] = STANCES.find((s) => s === val) ?? 'unresolved';
  }
  return reads;
}

/**
 * Turn one shark's conclusion into the compact SharkArgument the Block Kit
 * panel renders. Prefers the typed `structured` position (the normal path via
 * the submit_position tool); falls back to scraping the free-text `position`
 * for the rare case a model answered with prose instead of calling the tool.
 */
export function parseSharkArgument(result: AgentResult): SharkArgument {
  if (result.structured) {
    const p = result.structured;
    return {
      claim: cleanLine(p.recommendation) || cleanLine(result.position) || 'Weighed in on this.',
      // ONLY the model's own evidence bullets — never result.evidence, which is
      // the raw tool-call audit trail (`roadmapLookup → {…json…}`), not copy.
      evidence: p.evidence.map((e) => e.trim()).filter(isDisplayable).slice(0, 2),
      conceded: p.stance.toLowerCase().includes('defer'),
    };
  }

  // Fallback: the model answered with prose (or emitted its tool call as text)
  // instead of calling submit_position. Scrape headed fields if present, but
  // still never surface the raw tool JSON — degrade to a clean minimal card.
  const text = result.position;
  const stance = field(text, 'STANCE');
  const recommendation = field(text, 'RECOMMENDATION');
  const evidenceBlock = text.match(/EVIDENCE:\s*([\s\S]*?)(?:\n[A-Z ]+:|$)/)?.[1] ?? '';
  const evidence = evidenceBlock
    .split('\n')
    .map((line) => line.replace(/^-+\s*/, '').trim())
    .filter(isDisplayable)
    .slice(0, 2);

  return {
    claim: cleanLine(recommendation) || cleanLine(text) || 'Weighed in on this.',
    evidence,
    conceded: stance?.toUpperCase().includes('DEFER') ?? false,
  };
}

/** Is a string safe to show on a card — i.e. NOT raw tool output or tool-call
 *  syntax that leaks in when a model narrates its evidence / emits its tool call
 *  as text instead of calling submit_position natively. */
function isDisplayable(s: string): boolean {
  if (!s) return false;
  if (s.startsWith('<')) return false; // `<invoke ...>` / XML tool-call syntax
  if (/(^|\s)[\w-]+\s*→\s*[[{]/.test(s)) return false; // "toolName → {json}" audit line
  if (s.startsWith('{') || s.startsWith('[')) return false; // raw JSON blob
  return true;
}

/** First display-safe line of a blob, trimmed and length-capped. */
function cleanLine(s: string | undefined): string {
  if (!s) return '';
  const line = s
    .split('\n')
    .map((l) => l.trim())
    .find(isDisplayable);
  if (!line) return '';
  return line.length > 240 ? `${line.slice(0, 237)}…` : line;
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
