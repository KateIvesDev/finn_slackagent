/**
 * Individual tool stubs + the assembled registry.
 *
 * Every `execute` here is a STUB: it returns typed, realistic-looking data so
 * the orchestration loop is exercisable end-to-end without hitting real APIs.
 * Replace the bodies (marked `// TODO`) with real MCP calls — most of these
 * are thin wrappers over the Zendesk (Vaultdesk) and Slack MCP servers.
 *
 * See src/mcp/client.ts for the MCP client factory these will use.
 */
import { defineTool, createRegistry } from './registry.js';
import { getSlackMcpClient } from '../mcp/client.js';

// --- Result shapes returned by tools --------------------------------------
// Keeping these explicit makes the model's tool-result feedback predictable.

// mcp.slack.com's search tool returns one formatted markdown blob covering all
// matches (channel/author/time/permalink/text interleaved as text), not clean
// discrete fields per match — so this mirrors that rather than force a shape
// the real tool doesn't produce.
export interface SlackSearchResult {
  resultsText: string;
}
export interface ZendeskTicket {
  id: number;
  subject: string;
  description: string;
  status: string;
  org?: string;
  tags: string[];
}
export interface ZendeskSearchResult {
  tickets: ZendeskTicket[];
}
export interface CreatedRef {
  id: string;
  url: string;
}
export interface JiraIssue {
  key: string;
  summary: string;
  issueType: string;
  status: string;
}
export interface JiraSearchResult {
  issues: JiraIssue[];
}

// ---------------------------------------------------------------------------
// Slack real-time search (via Slack MCP server)
// ---------------------------------------------------------------------------
export const slackRtsSearch = defineTool<{ query: string }, SlackSearchResult>({
  name: 'slackRtsSearch',
  description:
    'Search Slack messages across channels for prior discussion related to a query. Use to find whether this feedback has been raised before.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms / keywords.' },
    },
    required: ['query'],
  },
  async execute(input) {
    // Only search:read.public is granted (see CLAUDE.md), so this must call
    // slack_search_public, not slack_search_public_and_private (which needs
    // extra consent scopes we deliberately didn't request).
    try {
      const client = await getSlackMcpClient();
      const result = await client.callTool({
        name: 'slack_search_public',
        arguments: { query: input.query, limit: 5 },
      });
      const block = (result.content as { type: string; text?: string }[] | undefined)?.find(
        (c) => c.type === 'text' && typeof c.text === 'string',
      );
      if (!block?.text) return { resultsText: 'No results.' };
      const parsed = JSON.parse(block.text) as { results?: string };
      return { resultsText: parsed.results ?? 'No results.' };
    } catch (err) {
      // A flaky search call shouldn't take down the whole shark debate — let
      // this persona reason with "search unavailable" rather than reject the
      // Promise.all in runFinnFlow and silence every shark.
      return { resultsText: `Slack search unavailable: ${(err as Error).message}` };
    }
  },
});

// ---------------------------------------------------------------------------
// Zendesk (Vaultdesk MCP server)
// ---------------------------------------------------------------------------
export const zendeskSearchTickets = defineTool<
  { query: string; status?: string },
  ZendeskSearchResult
>({
  name: 'zendeskSearchTickets',
  description:
    'Search Zendesk tickets to quantify how many customers reported an issue and read their phrasing. Use to gauge impact.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms.' },
      status: { type: 'string', description: 'Optional status filter.' },
    },
    required: ['query'],
  },
  async execute(input) {
    // TODO: call the Zendesk MCP server search tool.
    return {
      tickets: [
        {
          id: 1,
          subject: `[STUB] ticket for "${input.query}"`,
          description: 'stubbed description',
          status: input.status ?? 'open',
          tags: [],
        },
      ],
    };
  },
});

export const zendeskCreateTicket = defineTool<
  { subject: string; body: string; tags?: string[] },
  CreatedRef
>({
  name: 'zendeskCreateTicket',
  description: 'Create a Zendesk ticket. Only used by the action executor after approval.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      body: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['subject', 'body'],
  },
  async execute(_input) {
    // TODO: call the Zendesk MCP server create-ticket tool.
    return { id: 'STUB-ZD-1', url: 'https://example.zendesk.com/agent/tickets/1' };
  },
});

// ---------------------------------------------------------------------------
// Jira (via Jira MCP server or REST — wire through MCP client)
// ---------------------------------------------------------------------------
export const jiraSearchIssues = defineTool<{ jql: string }, JiraSearchResult>({
  name: 'jiraSearchIssues',
  description:
    'Search Jira issues (JQL) to check whether a bug/feature is already tracked. Use before proposing to create a new issue.',
  inputSchema: {
    type: 'object',
    properties: {
      jql: { type: 'string', description: 'A JQL query string.' },
    },
    required: ['jql'],
  },
  async execute(_input) {
    // TODO: call the Jira MCP server / REST search.
    return { issues: [] }; // empty => "no existing issue", drives the bug-spike storyline
  },
});

export const jiraCreateIssue = defineTool<
  { summary: string; description: string; issueType: string },
  CreatedRef
>({
  name: 'jiraCreateIssue',
  description: 'Create a Jira issue. Only used by the action executor after approval.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      description: { type: 'string' },
      issueType: { type: 'string', description: "e.g. 'Bug', 'Story'." },
    },
    required: ['summary', 'description', 'issueType'],
  },
  async execute(_input) {
    // TODO: call the Jira MCP server / REST create.
    return { id: 'STUB-JIRA-1', url: 'https://example.atlassian.net/browse/DEMO-1' };
  },
});

// ---------------------------------------------------------------------------
// Slack post (via Slack MCP server) — used by the 'none' action to reply.
// ---------------------------------------------------------------------------
export const slackPostMessage = defineTool<
  { channel: string; text: string; threadTs?: string },
  { ok: boolean; ts: string }
>({
  name: 'slackPostMessage',
  description: 'Post a message (optionally threaded) into a Slack channel.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      text: { type: 'string' },
      threadTs: { type: 'string' },
    },
    required: ['channel', 'text'],
  },
  async execute(_input) {
    // TODO: call the Slack MCP server post-message tool.
    return { ok: true, ts: '0000000000.000000' };
  },
});

/** The full registry every agent draws from. Personas subset this by name. */
export const toolRegistry = createRegistry([
  slackRtsSearch,
  zendeskSearchTickets,
  zendeskCreateTicket,
  jiraSearchIssues,
  jiraCreateIssue,
  slackPostMessage,
]);
