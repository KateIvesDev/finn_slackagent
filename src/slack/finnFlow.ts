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
import { postFinnOpener, postFinnVerdict, postFinnAutoHandled } from './finnpost.js';
import { postShark } from './sharks.js';
import { thinkAbout, resolveReactions } from './reactions.js';
import { buildResolvedFooter, routeVerdict } from './verdictCard.js';
import { recordVerdict, WebApiCanvasWriter } from './finnledger.js';
import { InMemoryDecisionLog, DynamoDecisionLog, type DecisionLog } from './decisionLog.js';
import { publishHome } from './apphome.js';
import { scenarios as demoScenarios, getScenario } from '../../seed/scenarios.js';
import { logAgentResponse } from '../observability/log.js';
import { summarizeActivity } from '../agents/summarize.js';

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
  const startedAt = Date.now();
  await postFinnOpener(client, feedback.channel, feedback.threadTs);

  const input = `Product feedback to evaluate:\n\n"""${feedback.text}"""`;
  const turns: SharkTurn[] = [];

  try {
    // Run the sharks concurrently, but ISOLATE each one's failure. A single
    // shark throwing (a Bedrock throttle that outlasted the client retries, a
    // Slack hiccup) must NOT abort the whole debate via Promise.all and leave a
    // half-posted thread — the panel proceeds with whoever succeeded.
    const settled = await Promise.all(
      personas.map(async (persona): Promise<AgentResult | null> => {
        try {
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
        } catch (err) {
          console.error(`[finnFlow] shark "${persona.id}" failed:`, err);
          // Subtle note so the panel doesn't have a silent hole on the stage.
          await client.chat
            .postMessage({
              channel: feedback.channel,
              thread_ts: feedback.threadTs,
              text: `_${persona.label} couldn't weigh in on this one — Finn is proceeding without it._`,
            })
            .catch(() => {});
          return null;
        }
      }),
    );

    const positions = settled.filter((r): r is AgentResult => r !== null);

    // Nothing survived — post a graceful fallback instead of dying silently.
    if (positions.length === 0) {
      await client.chat.postMessage({
        channel: feedback.channel,
        thread_ts: feedback.threadTs,
        text: ":finn: Finn couldn't convene the panel this time — please try again in a moment.",
      });
      logAgentResponse({
        userId: feedback.user,
        model: process.env.BEDROCK_MODEL_ID,
        toolsCalled: [],
        outcome: 'failure',
        totalLatencyMs: Date.now() - startedAt,
        errorType: 'all_sharks_failed',
      });
      return;
    }

    const verdict = await runJudge(positions);

    const resolvedTurns = turns.map((t) => ({ ...t, stance: verdict.reads[t.role] }));
    await resolveReactions(client, feedback.channel, resolvedTurns, { settleMs: 500 });

    // ROUTING is the point of the panel: its (dis)agreement decides whether a
    // human is needed. Unanimous + low-stakes → Finn handles and logs it, no
    // interruption. Any dissent or a consequential action → escalate to a human
    // with the Approve/Reject card. Either way the reasoning is recorded.
    const ledgerChannel = ledgerChannelFor(feedback);
    if (routeVerdict(verdict) === 'auto') {
      await executeVerdict(verdict, feedback);
      const ledgerEntry = {
        verdict,
        feedbackSummary: feedback.text,
        decision: 'auto' as const,
        decidedBy: 'Finn (autonomous)',
        at: new Date(),
      };
      await recordVerdict(ledgerFor(client), ledgerChannel, ledgerEntry);
      await decisionLogFor(client).record({ ...ledgerEntry, channel: ledgerChannel });
      await postFinnAutoHandled(client, feedback.channel, feedback.threadTs, verdict);
    } else {
      const verdictValue = JSON.stringify({ feedbackId: feedback.id });
      const verdictMessageTs = await postFinnVerdict(
        client,
        feedback.channel,
        feedback.threadTs,
        verdict,
        verdictValue,
        loadConfig().SLACK_PRODUCT_OWNER_GROUP_ID,
      );
      await store.set(feedback.id, { verdict, feedback, verdictMessageTs });
    }

    logAgentResponse({
      userId: feedback.user,
      model: process.env.BEDROCK_MODEL_ID,
      toolsCalled: positions.flatMap((p) => p.toolCalls.map((c) => c.name)),
      // 'partial' when we produced a verdict but a shark dropped out.
      outcome: positions.length < personas.length ? 'partial' : 'success',
      totalLatencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    // Safety net for anything past the sharks (judge, Slack posts). Log it and
    // leave the thread with an honest note rather than a silent dead end.
    console.error('[finnFlow] flow failed:', err);
    await client.chat
      .postMessage({
        channel: feedback.channel,
        thread_ts: feedback.threadTs,
        text: ':finn: Finn hit a snag reaching a verdict on this one. Please try again.',
      })
      .catch(() => {});
    logAgentResponse({
      userId: feedback.user,
      model: process.env.BEDROCK_MODEL_ID,
      toolsCalled: [],
      outcome: 'failure',
      totalLatencyMs: Date.now() - startedAt,
      errorType: err instanceof Error ? err.name : 'unknown',
    });
  }
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

// On Lambda (DECISION_TABLE_NAME set) the record and the "what's been decided?"
// summary run in separate invocations with no shared memory, so the log must be
// durable — one DynamoDecisionLog for the process. In Socket Mode there's no
// table; fall back to the per-client in-memory log (same WeakMap pattern as
// ledgerFor above — one long-lived process holds it all).
const decisionLogs = new WeakMap<WebClient, DecisionLog>();
let sharedDynamoDecisionLog: DynamoDecisionLog | undefined;
function decisionLogFor(client: WebClient): DecisionLog {
  if (process.env.DECISION_TABLE_NAME) {
    if (!sharedDynamoDecisionLog) sharedDynamoDecisionLog = new DynamoDecisionLog();
    return sharedDynamoDecisionLog;
  }
  let log = decisionLogs.get(client);
  if (!log) {
    log = new InMemoryDecisionLog();
    decisionLogs.set(client, log);
  }
  return log;
}

/** There's exactly one ledger of record, regardless of which entry point
 *  triggered a given debate — a decision made via a DM with Finn belongs in
 *  the same canvas/decision-log as one triggered from the feedback channel,
 *  not a separate one scoped to that DM's own channel id. */
function ledgerChannelFor(feedback: Feedback): string {
  return loadConfig().SLACK_FEEDBACK_CHANNEL || feedback.channel;
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
  const ledgerEntry = {
    verdict: entry.verdict,
    feedbackSummary: entry.feedback.text,
    decision: 'approved' as const,
    decidedBy,
    threadPermalink,
    at: new Date(),
  };
  const ledgerChannel = ledgerChannelFor(entry.feedback);
  await recordVerdict(ledgerFor(client), ledgerChannel, ledgerEntry);
  await decisionLogFor(client).record({ ...ledgerEntry, channel: ledgerChannel });

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
  const ledgerEntry = {
    verdict: entry.verdict,
    feedbackSummary: entry.feedback.text,
    decision: 'rejected' as const,
    decidedBy,
    threadPermalink,
    at: new Date(),
  };
  const ledgerChannel = ledgerChannelFor(entry.feedback);
  await recordVerdict(ledgerFor(client), ledgerChannel, ledgerEntry);
  await decisionLogFor(client).record({ ...ledgerEntry, channel: ledgerChannel });
}

/** "What's been decided recently?" — reads the last 7 days from the decision
 *  log (not the Canvas, which has no clean read-back API) and has the model
 *  synthesize a short digest. A different capability than triggering a
 *  fresh debate: retrieval over Finn's own memory, not re-running the sharks.
 *
 *  queryChannel is the real feedback channel (where the actual ledger of
 *  record lives), which may differ from replyChannel (e.g. asking from a DM
 *  should surface decisions from the feedback channel, not just whatever
 *  handful were triggered from that same DM). */
export async function handleSummarizeActivity(
  client: WebClient,
  replyChannel: string,
  _threadTs: string,
  queryChannel: string,
): Promise<void> {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const entries = await decisionLogFor(client).listRecent(queryChannel, SEVEN_DAYS_MS);
  const digest = await summarizeActivity(entries);
  // Top-level (no thread_ts) so the digest reads as a flat chat reply — see
  // handleAssistantHelp for why only the streamed debate needs a thread.
  // Render as a `markdown` block (GFM) not the `text` field: the model emits
  // standard `**bold**`, but Slack's `text` uses legacy mrkdwn (`*bold*`) and
  // would show the asterisks literally. `text` stays as the notification fallback.
  await client.chat.postMessage({
    channel: replyChannel,
    text: digest,
    blocks: [{ type: 'markdown', text: digest }],
  });
}

/** DM "help"/greeting handler — a static capability blurb so a greeting or
 *  "what can you do?" gets an onboarding answer instead of being misrouted into
 *  a full three-agent debate. No model call — instant on either transport. */
export async function handleAssistantHelp(
  client: WebClient,
  replyChannel: string,
  _threadTs: string,
): Promise<void> {
  const feedbackChannel = loadConfig().SLACK_FEEDBACK_CHANNEL;
  const channelRef = feedbackChannel ? `<#${feedbackChannel}>` : 'the feedback channel';
  // Post at the DM's top level (no thread_ts) so this reads as a flat chat
  // reply, not a threaded one. Only the streamed debate needs a thread (Slack's
  // chat.startStream requires thread_ts); a plain reply like this doesn't.
  await client.chat.postMessage({
    channel: replyChannel,
    text: "I'm Finn — I turn product feedback into fast, auditable decisions.",
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "👋 *I'm Finn — I turn product feedback into fast, auditable decisions.*\n\nSend me a bug, request, or complaint and I convene a panel — *Support, Engineering, and Product* — to debate it, then post a verdict with the reasoning. Clear-cut calls I handle myself; contested or high-stakes ones I route to a human to approve.",
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Here's what you can do:*\n• 📝 *Paste feedback* here or in ${channelRef} and I'll run the panel.\n• 🕘 Ask *"what's been decided recently?"* for a digest of recent verdicts.\n• 🏠 Open my *Home* tab for one-click demo scenarios, or to submit feedback with an account tier.`,
        },
      },
    ],
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
  // feedback from Ajax Corp" in seed/scenarios.ts), so fold it in the same way.
  const fullText =
    tier === 'enterprise' ? `New feedback from an enterprise account near renewal: ${text}` : text;

  const posted = await client.chat.postMessage({ channel, text: fullText });
  const ts = posted.ts as string;
  await runFinnFlow(client, store, { id: ts, text: fullText, channel, threadTs: ts });
}
