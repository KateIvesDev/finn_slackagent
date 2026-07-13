/**
 * Standalone Zendesk MCP server — the real external integration behind the #2
 * criterion ("connect external tools/data sources to Slack agents through the
 * open MCP standard"). It's a separate process the Finn agents connect to as an
 * MCP client (src/mcp/client.ts); it wraps the Zendesk REST API (src/zendesk/
 * client.ts) against a sandbox and exposes two tools:
 *
 *   - search_tickets   : full-text ticket search (Support's volume/recency signal)
 *   - get_organization : an org's plan / ARR / renewal / health custom fields
 *                        (the ARR-flip account context)
 *
 * Stateless Streamable HTTP transport over node:http (no extra deps). Run it
 * with `npm run mcp:zendesk`; point ZENDESK_MCP_URL at http://localhost:<port>/mcp.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { zendeskFromEnv, type ZendeskClient } from '../zendesk/client.js';
import { searchTicketsContent, getOrganizationContent } from '../zendesk/mcpTools.js';

const PORT = Number(process.env.ZENDESK_MCP_PORT ?? 8848);

/** Build a fresh MCP server wired to the Zendesk client. One per request keeps
 *  the stateless transport free of cross-request bleed. Tool bodies live in
 *  ../zendesk/mcpTools.ts so this and the Lambda handler can't drift. */
function buildServer(zd: ZendeskClient): McpServer {
  const server = new McpServer({ name: 'kalabook-zendesk', version: '0.1.0' });

  server.tool(
    'search_tickets',
    'Search Zendesk support tickets by keywords. Returns matching tickets with their org and age in days.',
    { query: z.string().describe('Keywords describing the issue to search for.') },
    async ({ query }) => {
      console.log(`[zendesk-mcp] search_tickets("${query}")`);
      return { content: await searchTicketsContent(zd, query) };
    },
  );

  server.tool(
    'get_organization',
    "Look up an organization's account context: plan, ARR (USD), renewal date, health, and notes.",
    { name: z.string().describe('Org name, or a fragment of it (e.g. "Ajax").') },
    async ({ name }) => {
      console.log(`[zendesk-mcp] get_organization("${name}")`);
      return { content: await getOrganizationContent(zd, name) };
    },
  );

  return server;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function main(): void {
  const zd = zendeskFromEnv(); // fails fast if creds are missing

  const http = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '';
      if (req.method !== 'POST' || !url.startsWith('/mcp')) {
        // Stateless server: no SSE streams / sessions to GET or DELETE.
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed — POST /mcp only' }));
        return;
      }
      try {
        const body = await readBody(req);
        // Fresh server + transport per request = clean stateless semantics.
        const server = buildServer(zd);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        console.error('[zendesk-mcp] request failed:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        }
      }
    })();
  });

  http.listen(PORT, () => {
    console.log(`🎫 Kalabook Zendesk MCP server on http://localhost:${PORT}/mcp`);
    console.log(`   Point ZENDESK_MCP_URL at that address for the agents to use it.`);
  });
}

main();
