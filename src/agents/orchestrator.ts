/**
 * The orchestrator. This is the heart of the app and it is deliberately
 * DECOUPLED from Slack and from Lambda:
 *
 *   - It takes a plain `Feedback` object and returns a `Verdict`.
 *   - It has no idea it's being called from a Bolt listener, a local script,
 *     or a future Lambda handler. Keep it that way.
 *
 * Flow: run the three personas in parallel (Promise.all) → feed their positions
 * to the judge → return the verdict. The Slack layer decides what to render and
 * the executor (post-approval) decides what to do with it.
 */
import { personas } from './personas.js';
import { runJudge } from './judge.js';
import { runAgent } from '../bedrock/runAgent.js';
import { toolRegistry } from '../tools/index.js';
import { selectTools } from '../tools/registry.js';
import type { Feedback, AgentResult } from '../types/index.js';
import type { Verdict } from '../slack/types.js';

/**
 * Run the full debate + judgement for a feedback item.
 * Pure async — safe to call from anywhere.
 */
export async function orchestrate(feedback: Feedback): Promise<Verdict> {
  // Frame the shared input each persona sees. (Personas differ by system
  // prompt + tools, not by the feedback text.)
  const input = `Product feedback to evaluate:\n\n"""${feedback.text}"""`;

  // --- 1. Three personas argue in parallel. ---
  // Promise.all runs them concurrently and preserves array order.
  const positions: AgentResult[] = await Promise.all(
    personas.map((persona) =>
      runAgent({
        persona: persona.id,
        systemPrompt: persona.systemPrompt,
        tools: selectTools(toolRegistry, persona.toolNames),
        input,
      }),
    ),
  );

  // --- 2. Judge reads the grounded positions and decides. ---
  const verdict = await runJudge(positions);

  return verdict;
}
