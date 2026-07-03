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
import type { PersonaName, AgentResult, ToolCallRecord } from '../types/index.js';

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
  const { persona, systemPrompt, tools, input } = args;

  // Index tools by name for O(1) dispatch during the loop.
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  // Conversation state. We seed it with the user's input.
  const messages: Message[] = [{ role: 'user', content: [{ text: input }] }];

  const toolCalls: ToolCallRecord[] = [];
  const finalText: string[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
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

      // The tool results come back to the model as a *user* message.
      messages.push({ role: 'user', content: toolResultBlocks });
      continue; // loop again so the model can react to the results
    }

    // No tool use => final answer. Collect all text blocks and stop.
    for (const block of message.content) {
      if ('text' in block && block.text) finalText.push(block.text);
    }
    break;
  }

  return {
    persona,
    position: finalText.join('\n').trim(),
    // TODO: derive structured evidence from toolCalls (e.g. pull the key facts
    // each search returned) instead of just recording the raw calls.
    evidence: toolCalls.map((c) => `${c.name} → ${JSON.stringify(c.output)}`),
    toolCalls,
  };
}
