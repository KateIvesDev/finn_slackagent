/**
 * The streamed variant of the Finn debate — same engine as finnFlow.ts
 * (personas, runAgent, runJudge, VerdictStore, buildVerdictCard), posted as a
 * single live stream inside a Slack Agent-container/DM conversation instead
 * of separate channel messages + reactions. Approve/Reject on the resulting
 * verdict card route through the exact same handleApprove/handleReject as
 * the channel flow — they only look up feedbackId in the store, they don't
 * care which surface created the entry. See src/slack/assistant.ts for the
 * Bolt Assistant class wiring that calls this.
 */
import type { WebClient } from '@slack/web-api';
import { personas } from '../agents/personas.js';
import { runJudge, parseSharkArgument } from '../agents/judge.js';
import { runAgent } from '../bedrock/runAgent.js';
import { toolRegistry } from '../tools/index.js';
import { selectTools } from '../tools/registry.js';
import type { Feedback, AgentResult } from '../types/index.js';
import type { VerdictStore } from './verdictStore.js';
import { SHARKS } from './sharks.js';
import { buildVerdictCard } from './verdictCard.js';
import { logAgentResponse } from '../observability/log.js';

export async function runFinnFlowStreamed(
  client: WebClient,
  store: VerdictStore,
  feedback: Feedback,
): Promise<void> {
  const startedAt = Date.now();

  await client.assistant.threads.setStatus({
    channel_id: feedback.channel,
    thread_ts: feedback.threadTs,
    status: 'Finn is convening the panel…',
  });

  // markdown_text is the only chunk type allowed on start/append — blocks are
  // reserved for stop() (see @slack/web-api's chat-stream.d.ts). ChatStreamer
  // buffers appended text and only calls the API once buffer_size is
  // exceeded (default 256 chars) — our per-shark chunks are short enough
  // that they'd never cross that threshold before stop() force-flushed
  // everything at once, which looks like "no streaming, just a final card."
  // A small buffer_size makes each append flush immediately instead.
  const streamer = client.chatStream({
    channel: feedback.channel,
    thread_ts: feedback.threadTs,
    buffer_size: 1,
  });

  const input = `Product feedback to evaluate:\n\n"""${feedback.text}"""`;
  const positions: AgentResult[] = [];

  try {
    // Stagger, don't batch: append each shark's take the instant it finishes,
    // same "Finn following along" principle runFinnFlow uses for reactions —
    // just feeding a stream instead of separate messages.
    await Promise.all(
      personas.map(async (persona) => {
        const result = await runAgent({
          persona: persona.id,
          systemPrompt: persona.systemPrompt,
          tools: selectTools(toolRegistry, persona.toolNames),
          input,
        });
        positions.push(result);

        const arg = parseSharkArgument(result);
        const { anchor, name } = SHARKS[persona.id];
        const concede = arg.conceded ? '  ·  _conceding_' : '';
        const evidenceLine = arg.evidence?.length
          ? `\n${arg.evidence.slice(0, 2).join('  ·  ')}`
          : '';
        await streamer.append({
          markdown_text: `${anchor} *${name}*${concede}\n${arg.claim}${evidenceLine}\n\n`,
        });
      }),
    );

    const verdict = await runJudge(positions);

    await streamer.append({
      markdown_text: `:finn: *Finn's call: ${verdict.headline}*\n${verdict.rationale}\n\n`,
    });

    // Name the thread after the verdict now that one exists — agent_view has
    // no dedicated "thread started" moment to do this earlier (see assistant.ts).
    await client.assistant.threads
      .setTitle({ channel_id: feedback.channel, thread_ts: feedback.threadTs, title: verdict.headline })
      .catch(() => {});

    const verdictValue = JSON.stringify({ feedbackId: feedback.id });
    const stopRes = await streamer.stop({
      blocks: buildVerdictCard(verdict, verdictValue),
    });

    const verdictMessageTs = stopRes.message?.ts;
    if (!verdictMessageTs) throw new Error('chat.stopStream did not return a message ts');

    await store.set(feedback.id, { verdict, feedback, verdictMessageTs });

    logAgentResponse({
      userId: feedback.user,
      model: process.env.BEDROCK_MODEL_ID,
      toolsCalled: positions.flatMap((p) => p.toolCalls.map((c) => c.name)),
      outcome: 'success',
      totalLatencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    await streamer.stop({});
    logAgentResponse({
      userId: feedback.user,
      model: process.env.BEDROCK_MODEL_ID,
      toolsCalled: positions.flatMap((p) => p.toolCalls.map((c) => c.name)),
      outcome: 'failure',
      totalLatencyMs: Date.now() - startedAt,
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    });
    throw err;
  }
}
