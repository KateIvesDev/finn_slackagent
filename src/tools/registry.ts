/**
 * Tool registry. A "tool" is the unit an agent can call during the Bedrock
 * Converse tool-use loop. Each tool declares:
 *   - name         : unique id the model references
 *   - description  : what it does (the model reads this to decide when to call it)
 *   - inputSchema  : JSON Schema for the arguments (Bedrock validates against this)
 *   - execute      : the actual implementation
 *
 * We keep the schema as a plain JSON-Schema object because that is exactly what
 * the Bedrock Converse `toolConfig` wants — no conversion step needed.
 */

/** Minimal JSON Schema shape we use for tool inputs. Loose on purpose. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * A registered tool. `TInput`/`TOutput` are generics so each tool is strongly
 * typed at its definition site while the registry stores them uniformly.
 * (Generics = type "parameters", like function args but for types.)
 */
export interface Tool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute: (input: TInput) => Promise<TOutput>;
}

/** Helper that preserves each tool's specific types while defining it. */
export function defineTool<TInput, TOutput>(
  tool: Tool<TInput, TOutput>,
): Tool<TInput, TOutput> {
  return tool;
}

/** A registry is just a name -> Tool map. */
export type ToolRegistry = Record<string, Tool>;

/** Build a registry from a list of tools, keyed by name. */
export function createRegistry(tools: Tool[]): ToolRegistry {
  const registry: ToolRegistry = {};
  for (const tool of tools) {
    if (registry[tool.name]) {
      throw new Error(`Duplicate tool name in registry: ${tool.name}`);
    }
    registry[tool.name] = tool;
  }
  return registry;
}

/** Pick a subset of tools by name — used to give each persona its own scope. */
export function selectTools(registry: ToolRegistry, names: string[]): Tool[] {
  return names.map((name) => {
    const tool = registry[name];
    if (!tool) throw new Error(`Unknown tool requested: ${name}`);
    return tool;
  });
}
