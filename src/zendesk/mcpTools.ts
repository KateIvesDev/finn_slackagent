/**
 * The Zendesk MCP tools — shared by BOTH server implementations so they can't
 * drift apart:
 *   - src/mcp-server/zendeskServer.ts  (SDK-based, `npm run mcp:zendesk`, local dev)
 *   - src/lambda/zendeskMcp.ts         (hand-rolled JSON-RPC, the deployed Lambda)
 *
 * Two tools: `search_tickets` (Support's volume/recency signal) and
 * `get_organization` (the ARR-flip account context). Both return MCP "content"
 * blocks (a single text block carrying JSON).
 */
import type { ZendeskClient } from './client.js';

/** An MCP tool result content block. */
export interface McpContent {
  type: 'text';
  text: string;
}

/** Plain JSON-Schema tool definitions — exactly what tools/list returns and
 *  what Bedrock/any MCP client validates against. */
export const ZENDESK_TOOL_DEFS = [
  {
    name: 'search_tickets',
    description:
      'Search Zendesk support tickets by keywords. Returns matching tickets with their org and age in days.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords describing the issue to search for.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_organization',
    description:
      "Look up an organization's account context: plan, ARR (USD), renewal date, health, and notes.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Org name, or a fragment of it (e.g. "Ajax").' },
      },
      required: ['name'],
    },
  },
] as const;

function daysAgo(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** search_tickets — resolve each ticket's org name so Support can argue "N orgs". */
export async function searchTicketsContent(zd: ZendeskClient, query: string): Promise<McpContent[]> {
  const raw = await zd.searchTickets(query);
  const tickets = await Promise.all(
    raw.map(async (t) => {
      const org = t.organizationId ? await zd.getOrganization(t.organizationId) : null;
      return {
        // Real Zendesk id so a shark that cites a ticket cites a truthful number
        // (otherwise the model invents one — it was rendering "#0").
        id: t.id,
        subject: t.subject,
        description: t.description,
        org: org?.name ?? 'Unknown',
        createdDaysAgo: daysAgo(t.createdAt),
        tags: t.tags,
      };
    }),
  );
  return [{ type: 'text', text: JSON.stringify({ count: tickets.length, tickets }) }];
}

/** get_organization — an org's custom fields (plan/ARR/renewal/health) + notes. */
export async function getOrganizationContent(zd: ZendeskClient, name: string): Promise<McpContent[]> {
  const org = await zd.findOrganizationByName(name);
  if (!org) {
    return [{ type: 'text', text: JSON.stringify({ found: false, name }) }];
  }
  return [
    {
      type: 'text',
      text: JSON.stringify({
        found: true,
        org: org.name,
        plan: org.plan,
        arrUsd: org.arrUsd,
        renewalDate: org.renewalDate,
        health: org.health,
        note: org.notes,
      }),
    },
  ];
}

/** Dispatch a tools/call by name. Throws on an unknown tool. */
export async function executeZendeskTool(
  zd: ZendeskClient,
  name: string,
  args: Record<string, unknown>,
): Promise<McpContent[]> {
  if (name === 'search_tickets') return searchTicketsContent(zd, String(args.query ?? ''));
  if (name === 'get_organization') return getOrganizationContent(zd, String(args.name ?? ''));
  throw new Error(`Unknown tool: ${name}`);
}
