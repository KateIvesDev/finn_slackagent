/**
 * The core reusable agent runner. Personas are *just configuration* — this
 * single function runs the Bedrock Converse tool-use loop for any of them.
 *
 * Loop control flow (this part is REAL, not stubbed):
 *   1. Send system prompt + conversation to the model.
 *   2. If the model wants to use tools (stopReason === 'tool_use'):
 *        - execute each requested tool
 *        - append the assistant's tool_use message AND a user message
 *          carrying the tool results
 *        - go back to step 1
 *   3. Otherwise it produced final text — collect it and stop.
 *
 * The Bedrock network call and the tool bodies are stubbed elsewhere; the loop
 * itself is genuine so the shape is correct.
 */
import type { Message, ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { converse } from './client.js';
import type { Tool } from '../tools/registry.js';
import { submitPositionTool, SUBMIT_POSITION } from '../agents/outputTools.js';
import type { SubmitPositionInput } from '../agents/outputTools.js';
import type {
  PersonaName,
  AgentResult,
  ToolCallRecord,
  SharkPosition,
} from '../types/index.js';

export interface RunAgentArgs {
  persona: PersonaName;
  systemPrompt: string;
  /** The scoped toolset this agent may call. */
  tools: Tool[];
  /** The user-facing input (the feedback + any framing). */
  input: string;
}

/** Safety valve so a misbehaving model can't loop forever. */
const MAX_TURNS = 8;

export async function runAgent(args: RunAgentArgs): Promise<AgentResult> {
  const { persona, systemPrompt, input } = args;

  // The model always gets one extra tool beyond its evidence toolset: the
  // submit_position SENTINEL. The prompt tells it to call this to conclude
  // (rather than write prose), which lets us read a typed position off the
  // tool args instead of scraping headed free text. See outputTools.ts.
  const tools: Tool[] = [...args.tools, submitPositionTool];

  // Index tools by name for O(1) dispatch during the loop.
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  // Conversation state. We seed it with the user's input.
  const messages: Message[] = [{ role: 'user', content: [{ text: input }] }];

  const toolCalls: ToolCallRecord[] = [];
  const finalText: string[] = [];
  let structured: SharkPosition | undefined;

  for (let turn = 0; turn < MAX_TURNS && !structured; turn++) {
    const response = await converse({
      system: [{ text: systemPrompt }],
      messages,
      tools,
    });

    const message = response.output?.message;
    if (!message?.content) break;

    // Record the assistant's turn verbatim so tool_use ids line up.
    messages.push(message);

    if (response.stopReason === 'tool_use') {
      // Gather every toolUse block, execute them, and feed results back.
      const toolResultBlocks: ContentBlock[] = [];

      for (const block of message.content) {
        if (!('toolUse' in block) || !block.toolUse) continue;
        const { toolUseId, name, input: toolInput } = block.toolUse;

        // The sentinel: the persona is concluding. Capture its typed args as
        // the structured position and stop — do NOT execute it or loop again.
        if (name === SUBMIT_POSITION) {
          structured = toSharkPosition(toolInput);
          toolCalls.push({ name, input: toolInput, output: '<submitted>' });
          break;
        }

        const tool = toolByName.get(name ?? '');
        let output: unknown;
        try {
          if (!tool) throw new Error(`Agent requested unknown tool: ${name}`);
          output = await tool.execute(toolInput);
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) };
        }

        toolCalls.push({ name: name ?? 'unknown', input: toolInput, output });

        toolResultBlocks.push({
          toolResult: {
            toolUseId,
            // `json` is a loosely-typed "document" in the SDK — cast our result.
            content: [{ json: output as never }],
          },
        });
      }

      if (structured) break; // concluded via the sentinel — we're done

      // The tool results come back to the model as a *user* message.
      messages.push({ role: 'user', content: toolResultBlocks });
      continue; // loop again so the model can react to the results
    }

    // No tool use => the model concluded with TEXT instead of calling the
    // sentinel (Claude occasionally writes the call in its text format,
    // `<invoke name="submit_position">…`, when it isn't forced). Keep the text
    // as a last-ditch fallback, then FORCE one more turn with toolChoice pinned
    // to submit_position — Converse won't let a forced tool be answered with
    // text, so this reliably captures the typed position (same guarantee the
    // Judge gets). A user nudge keeps the turns alternating for Converse.
    for (const block of message.content) {
      if ('text' in block && block.text) finalText.push(block.text);
    }
    console.log(`[runAgent] ${persona} concluded with text → forcing submit_position`);
    messages.push({
      role: 'user',
      content: [{ text: 'Now submit your final position by calling the submit_position tool.' }],
    });
    structured = await forceSubmitPosition(systemPrompt, messages, tools);
    if (structured) toolCalls.push({ name: SUBMIT_POSITION, input: structured, output: '<forced>' });
    break;
  }

  return {
    persona,
    // Prefer a readable rendering of the structured position for the judge
    // brief / logs; fall back to whatever prose the model produced.
    position: structured ? renderPosition(structured) : finalText.join('\n').trim(),
    // TODO: derive structured evidence from toolCalls (e.g. pull the key facts
    // each search returned) instead of just recording the raw calls.
    evidence: toolCalls.map((c) => `${c.name} → ${JSON.stringify(c.output)}`),
    toolCalls,
    structured,
  };
}

/**
 * The model ended a turn with text instead of calling submit_position. Do one
 * more turn with toolChoice FORCING submit_position, so we still capture a typed
 * position. `messages` must already end with a user turn (the nudge) for the
 * assistant response to be valid. Returns undefined only if the forced call
 * somehow produced no tool_use (shouldn't happen when a tool is forced).
 */
async function forceSubmitPosition(
  systemPrompt: string,
  messages: Message[],
  tools: Tool[],
): Promise<SharkPosition | undefined> {
  const response = await converse({
    system: [{ text: systemPrompt }],
    messages,
    tools,
    toolChoice: { tool: { name: SUBMIT_POSITION } },
  });
  const content = response.output?.message?.content ?? [];
  for (const block of content) {
    if ('toolUse' in block && block.toolUse?.name === SUBMIT_POSITION) {
      return toSharkPosition(block.toolUse.input);
    }
  }
  return undefined;
}

/** Normalize the raw submit_position tool args into a SharkPosition, guarding
 *  the shape (the SDK types tool input as a loose "document"). */
function toSharkPosition(rawInput: unknown): SharkPosition {
  const raw = (rawInput ?? {}) as Partial<SubmitPositionInput>;
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.map((e) => String(e)).filter(Boolean)
    : [];
  return {
    stance: String(raw.stance ?? 'defer'),
    confidence: raw.confidence ? String(raw.confidence) : undefined,
    recommendation: String(raw.recommendation ?? '').trim(),
    evidence,
    agreement: raw.agreement ? String(raw.agreement) : undefined,
  };
}

/** Render a structured position back to the headed text the judge brief reads. */
function renderPosition(p: SharkPosition): string {
  const lines = [
    `STANCE: ${p.stance}`,
    `RECOMMENDATION: ${p.recommendation}`,
    'EVIDENCE:',
    ...p.evidence.map((e) => `- ${e}`),
  ];
  if (p.agreement) lines.push(`AGREEMENT: ${p.agreement}`);
  return lines.join('\n');
}
