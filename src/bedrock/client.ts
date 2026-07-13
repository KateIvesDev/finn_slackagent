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
  ToolChoice,
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
  /** Optional tool-choice constraint. Pass `{ tool: { name } }` to FORCE the
   *  model to call one specific tool (how the Judge guarantees a structured
   *  verdict). Omit for the normal "call tools if you want" behavior. */
  toolChoice?: ToolChoice;
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
    // Bedrock rejects toolConfig.tools with length 0 outright ("Invalid
    // length for parameter toolConfig.tools, valid min length: 1") — so omit
    // toolConfig entirely for callers with no tools. (The judge now always
    // passes its submit_verdict output tool, so it takes the populated branch.)
    toolConfig:
      args.tools.length > 0
        ? { tools: toBedrockTools(args.tools), toolChoice: args.toolChoice }
        : undefined,
  });
  return sendWithRetry(command);
}

/** Transient Bedrock errors a short backoff usually clears. We fire three
 *  sharks + the judge concurrently, which makes throttling likely on on-demand
 *  capacity — and an unretried throttle would otherwise abort a whole debate. */
const RETRYABLE_ERRORS = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ModelTimeoutException',
  'ServiceUnavailableException',
  'InternalServerException',
]);

async function sendWithRetry(
  command: ConverseCommand,
  maxAttempts = 4,
): Promise<ConverseCommandOutput> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await client().send(command);
    } catch (err) {
      lastErr = err;
      const name = (err as { name?: string })?.name ?? '';
      if (!RETRYABLE_ERRORS.has(name) || attempt === maxAttempts - 1) throw err;
      // Exponential backoff with jitter: ~0.5s, 1s, 2s (+ up to 250ms).
      const backoff = 500 * 2 ** attempt + Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastErr; // unreachable — the loop either returns or throws
}

/**
 * Stubbed model turn. Mimics the Converse output shape so the loop and the
 * structured-output path both run with ZERO credentials. Flip BEDROCK_STUB=false
 * (and set creds) for real calls.
 *
 * When a `submit_*` output tool is offered (see src/agents/outputTools.ts), the
 * stub returns a `tool_use` turn "calling" it with canned typed args — so the
 * shark/judge structured path is exercised locally, not just the old free-text
 * one. Otherwise it returns a final text turn so the loop ends.
 */
function stubConverse(args: ConverseArgs): ConverseCommandOutput {
  const hasTool = (name: string) => args.tools.some((t) => t.name === name);

  // Judge: forced submit_verdict — hand back a canned typed verdict.
  if (hasTool('submit_verdict')) {
    return toolUseOutput('submit_verdict', {
      headline: '[STUB] File it — new bug',
      action: 'create_jira',
      rationale:
        '[STUB] Multiple customers reported the same behavior and no matching Jira issue exists, so file a new bug.',
      consensus: 'All three agree this is a real, untracked defect.',
      tension: 'none',
      decidingFactor: 'A fresh cluster of reports with nothing tracked.',
      reads: { support: 'favored', engineering: 'favored', product: 'unresolved' },
      details: 'Bug, high priority',
    });
  }

  // Shark: submit_position sentinel present — hand back a canned typed position.
  if (hasTool('submit_position')) {
    return toolUseOutput('submit_position', {
      stance: 'act',
      confidence: 'medium',
      recommendation: '[STUB] File a bug for the reported issue.',
      evidence: ['[STUB] 3 similar reports this week', '[STUB] no matching issue tracked'],
      agreement: 'Expect the panel to agree this is a real defect.',
    });
  }

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
            text: `[STUB text] Based on the input "${echo}", my position is: <fill in real reasoning>.`,
          },
        ],
      },
    },
    stopReason: 'end_turn',
  } as unknown as ConverseCommandOutput;
}

/** Build a stub `tool_use` Converse output "calling" `name` with `input`. */
function toolUseOutput(name: string, input: unknown): ConverseCommandOutput {
  return {
    $metadata: {},
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: `stub-${name}`, name, input } }],
      },
    },
    stopReason: 'tool_use',
  } as unknown as ConverseCommandOutput;
}
