/**
 * MCP client factory. Our agents/tools are MCP *clients*: they connect to
 * remote MCP *servers* over HTTP (streamable HTTP transport). Server URLs come
 * from env — they are configurable remote endpoints, NOT localhost.
 *
 *   - Zendesk MCP server (Vaultdesk): ZENDESK_MCP_URL
 *   - Slack MCP server:               SLACK_MCP_URL
 *
 * Clients are cached per-URL so we open one connection and reuse it. The tool
 * stubs in src/tools/index.ts will call these once wired up.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../config/index.js';

// Cache of live clients keyed by URL so we don't reconnect on every tool call.
const clients = new Map<string, Client>();

/**
 * Connect to (or reuse) an MCP server at `url`. Returns a ready MCP client you
 * can call `.callTool(...)` / `.listTools()` on. Pass `bearerToken` for
 * servers that require auth (e.g. mcp.slack.com — see getSlackMcpClient).
 */
export async function getMcpClient(url: string, bearerToken?: string): Promise<Client> {
  const existing = clients.get(url);
  if (existing) return existing;

  const client = new Client(
    { name: 'slackagent', version: '0.1.0' },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: bearerToken ? { headers: { Authorization: `Bearer ${bearerToken}` } } : undefined,
  });
  await client.connect(transport);

  clients.set(url, client);
  return client;
}

/** Convenience: the Zendesk (Vaultdesk) MCP client. */
export async function getZendeskMcpClient(): Promise<Client> {
  const cfg = loadConfig();
  if (!cfg.ZENDESK_MCP_URL) throw new Error('ZENDESK_MCP_URL is not set.');
  return getMcpClient(cfg.ZENDESK_MCP_URL);
}

/** Convenience: the Slack MCP client. Requires a USER token (xoxp-...), not
 *  the bot token — mcp.slack.com's Real-time Search API rejects bot tokens
 *  for search (see CLAUDE.md / .env.example for the scope requirements). */
export async function getSlackMcpClient(): Promise<Client> {
  const cfg = loadConfig();
  if (!cfg.SLACK_MCP_URL) throw new Error('SLACK_MCP_URL is not set.');
  if (!cfg.SLACK_MCP_USER_TOKEN) throw new Error('SLACK_MCP_USER_TOKEN is not set.');
  return getMcpClient(cfg.SLACK_MCP_URL, cfg.SLACK_MCP_USER_TOKEN);
}

/** Close all open MCP connections (call on shutdown). */
export async function closeAllMcpClients(): Promise<void> {
  await Promise.all([...clients.values()].map((c) => c.close()));
  clients.clear();
}
