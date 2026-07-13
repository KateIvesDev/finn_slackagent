/**
 * "What's been decided recently?" — a chat-surface capability distinct from
 * triggering a fresh debate: retrieval + synthesis over Finn's own memory
 * (the decision log) rather than re-running the sharks. No tools, one model
 * call, same pattern the Judge uses (converse() directly, not runAgent's
 * tool-use loop, since there's nothing to call a tool for here).
 */
import { converse } from '../bedrock/client.js';
import type { DecisionLogEntry } from '../slack/decisionLog.js';

const SUMMARY_PROMPT = `
You are Finn, summarizing recent product-feedback decisions for a teammate
who just asked what's been happening. You'll get a numbered list of past
verdicts (headline, action taken, rationale, approved/rejected). Write a
short digest: 3-5 sentences, prose, no headers or bullet lists. Call out any
real pattern — which action types dominate, repeated themes across
complaints, or any overruled/rejected calls worth flagging. Don't restate
every entry; synthesize.
`.trim();

export async function summarizeActivity(entries: DecisionLogEntry[]): Promise<string> {
  if (entries.length === 0) {
    return "No decisions recorded yet in this channel — nothing to summarize.";
  }

  const brief = entries
    .map((e, i) => `${i + 1}. [${e.decision}] ${e.verdict.headline} — ${e.verdict.action.label}. ${e.verdict.rationale}`)
    .join('\n');

  const response = await converse({
    system: [{ text: SUMMARY_PROMPT }],
    messages: [{ role: 'user', content: [{ text: brief }] }],
    tools: [],
  });

  const text =
    response.output?.message?.content?.find((c) => 'text' in c && c.text)?.[
      'text' as never
    ] ?? '';
  return String(text) || "Couldn't put together a summary right now.";
}
