/**
 * Zendesk MCP server, as a Lambda behind a Function URL.
 *
 * Why hand-rolled instead of the SDK transport (src/mcp-server/zendeskServer.ts):
 * the SDK's Streamable-HTTP transport is built around a persistent Node HTTP
 * server and can respond with SSE — awkward on Lambda's request/response model.
 * But the MCP spec lets a server answer a POST with plain `application/json`,
 * and this server is stateless with two tools — so a compact JSON-RPC handler on
 * a normal buffered Lambda is simpler and more reliable than fighting SSE. The
 * MCP client connects the same way; the tool bodies are shared (mcpTools.ts) so
 * this and the local SDK server never drift.
 *
 * Auth: a shared bearer secret (ZENDESK_MCP_TOKEN). The worker passes it via
 * getMcpClient(url, token); the URL is public so this gate is what protects the
 * Zendesk creds behind it.
 */
import { zendeskFromEnv, type ZendeskClient } from '../zendesk/client.js';
import { ZENDESK_TOOL_DEFS, executeZendeskTool } from '../zendesk/mcpTools.js';

// Minimal Lambda Function URL (API Gateway v2 payload) shapes — inlined to
// avoid an @types/aws-lambda dependency.
interface FnUrlEvent {
  requestContext?: { http?: { method?: string } };
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}
interface FnUrlResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SECRET = process.env.ZENDESK_MCP_TOKEN;
const JSON_HEADERS = { 'content-type': 'application/json' };

// Lazily build the Zendesk client so a cold start that never gets a request
// doesn't need creds; reused across warm invocations.
let _zd: ZendeskClient | null = null;
function zd(): ZendeskClient {
  if (!_zd) _zd = zendeskFromEnv();
  return _zd;
}

const ok = (id: JsonRpcMessage['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const err = (id: JsonRpcMessage['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/** Handle one JSON-RPC message. Returns the response object, or null for
 *  notifications (which get no response — the caller replies 202). */
async function handleMessage(msg: JsonRpcMessage): Promise<object | null> {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return ok(id, {
        // Echo the client's requested version (we're version-agnostic).
        protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'kalabook-zendesk', version: '0.1.0' },
      });
    case 'notifications/initialized':
    case 'initialized':
      return null; // notification — no response
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: ZENDESK_TOOL_DEFS });
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      console.log(`[zendesk-mcp] tools/call ${name} ${JSON.stringify(args)}`);
      try {
        return ok(id, { content: await executeZendeskTool(zd(), name, args) });
      } catch (e) {
        // Tool errors are reported in-band (isError), not as JSON-RPC errors,
        // per MCP — so the model sees the failure rather than the call rejecting.
        return ok(id, {
          content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      }
    }
    default:
      // Requests (with an id) get a proper error; stray notifications are ignored.
      return id === undefined || id === null ? null : err(id, -32601, `Method not found: ${method}`);
  }
}

export async function handler(event: FnUrlEvent): Promise<FnUrlResult> {
  const method = event.requestContext?.http?.method ?? 'POST';
  if (method !== 'POST') {
    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'POST only' }) };
  }

  // Shared-secret auth via a CUSTOM header — NOT `Authorization`, which a
  // Function URL (AuthType NONE) rejects with 403 before we ever run. Function
  // URL header keys arrive lowercased.
  if (SECRET) {
    const token = event.headers?.['x-mcp-token'] ?? event.headers?.['X-Mcp-Token'];
    if (token !== SECRET) {
      return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }
  }

  let payload: unknown;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');
    payload = JSON.parse(raw);
  } catch {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }

  // Support a single message or a JSON-RPC batch.
  const batch = Array.isArray(payload);
  const messages = (batch ? payload : [payload]) as JsonRpcMessage[];
  const responses: object[] = [];
  for (const msg of messages) {
    const r = await handleMessage(msg);
    if (r) responses.push(r);
  }

  // All notifications → 202 Accepted, no body (per the Streamable-HTTP spec).
  if (responses.length === 0) return { statusCode: 202, body: '' };

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify(batch ? responses : responses[0]),
  };
}
