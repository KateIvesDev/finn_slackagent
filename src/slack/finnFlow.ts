/**
 * The actual Finn flow — transport-agnostic. Everything here takes a plain
 * WebClient + VerdictStore, so it runs identically whether it's called
 * directly inside a long-lived Socket Mode process or from a Lambda worker
 * invocation. See src/slack/taskRunner.ts for how a WorkTask maps to these.
 */
import type { WebClient } from '@slack/web-api';
import { loadConfig } from '../config/index.js';
import { personas } from '../agents/personas.js';
import { runJudge, parseSharkArgument } from '../agents/judge.js';
import { executeVerdict } from '../agents/executor.js';
import { runAgent } from '../bedrock/runAgent.js';
import { toolRegistry } from '../tools/index.js';
import { selectTools } from '../tools/registry.js';
import type { Feedback, AgentResult } from '../types/index.js';
import type { SharkTurn, Scenario as HomeScenario } from './types.js';
import type { VerdictStore } from './verdictStore.js';
import { postFinnOpener, postFinnVerdict } from './finnpost.js';
import { postShark } from './sharks.js';
import { thinkAbout, resolveReactions } from './reactions.js';
import { buildResolvedFooter } from './verdictCard.js';
import { recordVerdict, WebApiCanvasWriter } from './finnledger.js';
import { publishHome } from './apphome.js';
import { scenarios as demoScenarios, getScenario } from '../../seed/scenarios.js';

// App Home's canned-scenario cards are spoiler-free: show the trigger
// feedback a judge is about to fire, not the expected verdict/rationale.
const homeScenarios: HomeScenario[] = demoScenarios.map((s) => ({
  id: s.id,
  title: s.title,
  blurb:
    s.triggerFeedback.text.length > 140
      ? `${s.triggerFeedback.text.slice(0, 137)}...`
      : s.triggerFeedback.text,
}));

/**
 * Convene the panel, let the sharks argue, resolve reactions, post the
 * verdict card. Runs all three sharks concurrently, but each posts its
 * argument and gets its 🤔 the INSTANT it individually finishes — that
 * staggering is what makes the reaction arc read as "Finn following along"
 * (FINN_DESIGN.md), not a batch job.
 */
export async function runFinnFlow(
  client: WebClient,
  store: VerdictStore,
  feedback: Feedback,
): Promise<void> {
  await postFinnOpener(client, feedback.channel, feedback.threadTs);

  const input = `Product feedback to evaluate:\n\n"""${feedback.text}"""`;
  const turns: SharkTurn[] = [];

  const positions: AgentResult[] = await Promise.all(
    personas.map(async (persona) => {
      const result = await runAgent({
        persona: persona.id,
        systemPrompt: persona.systemPrompt,
        tools: selectTools(toolRegistry, persona.toolNames),
        input,
      });

      const messageTs = await postShark(
        client,
        feedback.channel,
        persona.id,
        parseSharkArgument(result),
        feedback.threadTs,
      );
      await thinkAbout(client, feedback.channel, messageTs);
      turns.push({ role: persona.id, messageTs });

      return result;
    }),
  );

  const verdict = await runJudge(positions);

  const resolvedTurns = turns.map((t) => ({ ...t, stance: verdict.reads[t.role] }));
  await resolveReactions(client, feedback.channel, resolvedTurns, { settleMs: 500 });

  const verdictValue = JSON.stringify({ feedbackId: feedback.id });
  const verdictMessageTs = await postFinnVerdict(
    client,
    feedback.channel,
    feedback.threadTs,
    verdict,
    verdictValue,
  );

  await store.set(feedback.id, { verdict, feedback, verdictMessageTs });
}

const ledgerWriters = new WeakMap<WebClient, WebApiCanvasWriter>();
function ledgerFor(client: WebClient): WebApiCanvasWriter {
  let writer = ledgerWriters.get(client);
  if (!writer) {
    writer = new WebApiCanvasWriter(client);
    ledgerWriters.set(client, writer);
  }
  return writer;
}

/** Canvas markdown renders "<@U…>" as literal text (unlike a message, Slack
 *  doesn't resolve mention syntax there), so the ledger needs an actual name. */
async function resolveDisplayName(client: WebClient, userId: string): Promise<string> {
  try {
    const res = await client.users.info({ user: userId });
    const profile = res.user?.profile;
    return profile?.display_name || profile?.real_name || res.user?.real_name || userId;
  } catch {
    return userId;
  }
}

/** Approve → execute the action, record it in the decision ledger, resolve the card. */
export async function handleApprove(
  client: WebClient,
  store: VerdictStore,
  feedbackId: string,
  userId: string,
): Promise<void> {
  const entry = await store.get(feedbackId);
  if (!entry) return;

  const result = await executeVerdict(entry.verdict, entry.feedback);

  let threadPermalink: string | undefined;
  try {
    const perma = await client.chat.getPermalink({
      channel: entry.feedback.channel,
      message_ts: entry.feedback.threadTs,
    });
    threadPermalink = perma.permalink;
  } catch {
    // Non-critical — the ledger entry just won't have a link back.
  }

  const decidedBy = await resolveDisplayName(client, userId);
  await recordVerdict(ledgerFor(client), entry.feedback.channel, {
    verdict: entry.verdict,
    feedbackSummary: entry.feedback.text,
    decision: 'approved',
    decidedBy,
    threadPermalink,
  });

  await client.chat.update({
    channel: entry.feedback.channel,
    ts: entry.verdictMessageTs,
    text: `Finn's call: ${entry.verdict.headline} — approved`,
    blocks: buildResolvedFooter(entry.verdict, 'approved', userId),
  });

  if (result.url) {
    await client.chat.postMessage({
      channel: entry.feedback.channel,
      thread_ts: entry.feedback.threadTs,
      text: `${result.summary} <${result.url}|View>`,
    });
  }
}

/** Reject → resolve the card as overruled. Nothing executes. */
export async function handleReject(
  client: WebClient,
  store: VerdictStore,
  feedbackId: string,
  userId: string,
): Promise<void> {
  const entry = await store.get(feedbackId);
  if (!entry) return;

  await client.chat.update({
    channel: entry.feedback.channel,
    ts: entry.verdictMessageTs,
    text: `Finn's call: ${entry.verdict.headline} — rejected`,
    blocks: buildResolvedFooter(entry.verdict, 'rejected', userId),
  });

  let threadPermalink: string | undefined;
  try {
    const perma = await client.chat.getPermalink({
      channel: entry.feedback.channel,
      message_ts: entry.feedback.threadTs,
    });
    threadPermalink = perma.permalink;
  } catch {
    // Non-critical — the ledger entry just won't have a link back.
  }

  const decidedBy = await resolveDisplayName(client, userId);
  await recordVerdict(ledgerFor(client), entry.feedback.channel, {
    verdict: entry.verdict,
    feedbackSummary: entry.feedback.text,
    decision: 'rejected',
    decidedBy,
    threadPermalink,
  });
}

/** Publish Finn's App Home tab for a user. */
export async function publishFinnHome(client: WebClient, userId: string): Promise<void> {
  await publishHome(client, userId, homeScenarios);
}

/** App Home "Run it" button — post the scenario's trigger feedback for
 *  visual continuity, then run the debate on it directly (rather than
 *  relying on the message listener to re-detect a bot-posted message). */
export async function handleRunScenario(client: WebClient, store: VerdictStore, scenarioId: string): Promise<void> {
  const scenario = getScenario(scenarioId);
  const channel = loadConfig().SLACK_FEEDBACK_CHANNEL;
  if (!scenario || !channel) return;

  const posted = await client.chat.postMessage({ channel, text: scenario.triggerFeedback.text });
  const ts = posted.ts as string;
  await runFinnFlow(client, store, {
    id: ts,
    text: scenario.triggerFeedback.text,
    channel,
    threadTs: ts,
  });
}

/** App Home "submit your own feedback" modal submission. */
export async function handleFeedbackSubmit(
  client: WebClient,
  store: VerdictStore,
  text: string,
  tier: string | undefined,
): Promise<void> {
  const channel = loadConfig().SLACK_FEEDBACK_CHANNEL;
  if (!channel) return;

  // Org tier isn't a structured Feedback field — the sharks read context from
  // the feedback text itself (see how arrJudgment's trigger text embeds "New
  // feedback from Acme Corp" in seed/scenarios.ts), so fold it in the same way.
  const fullText =
    tier === 'enterprise' ? `New feedback from an enterprise account near renewal: ${text}` : text;

  const posted = await client.chat.postMessage({ channel, text: fullText });
  const ts = posted.ts as string;
  await runFinnFlow(client, store, { id: ts, text: fullText, channel, threadTs: ts });
}
