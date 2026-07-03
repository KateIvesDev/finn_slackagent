/**
 * Thin wrapper around the Bedrock Converse API.
 *
 * The real call goes through `@aws-sdk/client-bedrock-runtime`'s
 * `ConverseCommand`. During scaffolding we STUB the network call but keep the
 * request/response *shapes* real, so `runAgent`'s loop logic is exercised for
 * real. Swap the stubbed `converse()` body for the SDK call when ready.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  Message,
  Tool as BedrockTool,
  SystemContentBlock,
  ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { loadConfig } from '../config/index.js';
import type { Tool } from '../tools/registry.js';

// Lazily construct the SDK client so importing this module doesn't require AWS
// creds (the local orchestrator runs fully stubbed).
let _client: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!_client) {
    const cfg = loadConfig();
    _client = new BedrockRuntimeClient({ region: cfg.AWS_REGION });
  }
  return _client;
}

/** Convert our registry tools into Bedrock's `toolConfig.tools` shape.
 *  The AWS SDK models these as tagged unions whose "document" members are very
 *  loosely typed; a cast keeps our clean JSON Schema without fighting them. */
export function toBedrockTools(tools: Tool[]): BedrockTool[] {
  return tools.map(
    (t) =>
      ({
        toolSpec: {
          name: t.name,
          description: t.description,
          // Bedrock wants the JSON Schema wrapped as `{ json: <schema> }`.
          inputSchema: { json: t.inputSchema },
        },
      }) as BedrockTool,
  );
}

export interface ConverseArgs {
  system: SystemContentBlock[];
  messages: Message[];
  tools: Tool[];
}

/**
 * Send one turn to the model. Returns the raw Converse output so the caller
 * (`runAgent`) can inspect `stopReason` and content blocks.
 */
export async function converse(args: ConverseArgs): Promise<ConverseCommandOutput> {
  // Stubbed by default so the skeleton runs with ZERO credentials. Flip
  // BEDROCK_STUB=false (and set creds + BEDROCK_MODEL_ID) for real calls.
  // TODO: remove this short-circuit once you want real model calls always.
  if (process.env.BEDROCK_STUB !== 'false') {
    return stubConverse(args);
  }

  const cfg = loadConfig();
  if (!cfg.BEDROCK_MODEL_ID) {
    throw new Error('BEDROCK_MODEL_ID is not set — cannot call Bedrock.');
  }

  const command = new ConverseCommand({
    modelId: cfg.BEDROCK_MODEL_ID, // never hardcoded — comes from env
    system: args.system,
    messages: args.messages,
    toolConfig: { tools: toBedrockTools(args.tools) },
  });
  return client().send(command);
}

/**
 * Stubbed model turn. Mimics the Converse output shape with a final assistant
 * message so the loop ends. Flip BEDROCK_STUB=false (and set creds) for real.
 *
 * TODO: to test the tool-use branch of runAgent, temporarily return a
 * `stopReason: 'tool_use'` message with a `toolUse` content block here.
 */
function stubConverse(args: ConverseArgs): ConverseCommandOutput {
  const lastUser = [...args.messages].reverse().find((m) => m.role === 'user');
  const echo =
    lastUser?.content?.find((c) => 'text' in c && c.text)?.['text' as never] ??
    'no input';
  return {
    $metadata: {},
    output: {
      message: {
        role: 'assistant',
        content: [
          {
            text: `[STUB verdict text] Based on the input "${echo}", my position is: <fill in real reasoning>.`,
          },
        ],
      },
    },
    stopReason: 'end_turn',
  } as unknown as ConverseCommandOutput;
}
