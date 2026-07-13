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
import { WebClient } from '@slack/web-api';
import { defineTool, createRegistry } from './registry.js';
import { getSlackMcpClient, getZendeskMcpClient } from '../mcp/client.js';
import { loadConfig } from '../config/index.js';

// A cached Slack Web API client bound to the USER token (xoxp) — the Real-Time
// Search API (assistant.search.context) needs a user token + search:read.public
// and, per the method reference, NO action_token on the user-token path.
let _rtsClient: WebClient | null = null;
function rtsClient(): WebClient {
  if (!_rtsClient) {
    const cfg = loadConfig();
    if (!cfg.SLACK_MCP_USER_TOKEN) {
      throw new Error('SLACK_MCP_USER_TOKEN (xoxp user token) required for the Real-Time Search API.');
    }
    _rtsClient = new WebClient(cfg.SLACK_MCP_USER_TOKEN);
  }
  return _rtsClient;
}

/** One message result from assistant.search.context (the fields we render). */
interface RtsMessage {
  author_name?: string;
  channel_name?: string;
  content?: string;
  permalink?: string;
}

/**
 * Call a tool on the Zendesk MCP server (src/mcp-server/zendeskServer.ts) and
 * return its parsed JSON payload — or `null` when the server isn't configured
 * (ZENDESK_MCP_URL unset) or the call fails, so callers transparently fall back
 * to the curated catalog. This is what makes the real MCP integration safe to
 * ship: a cold/absent server degrades to the tuned local data, never a hard fail.
 */
async function callZendeskMcp(
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (!loadConfig().ZENDESK_MCP_URL) {
    // Silent-until-now: make the fallback visible so "the MCP didn't fire" is
    // obvious in Finn's console (set ZENDESK_MCP_URL + start `npm run mcp:zendesk`).
    console.log(`[zendeskMcp] ${toolName}: ZENDESK_MCP_URL not set → curated fallback`);
    return null;
  }
  try {
    const client = await getZendeskMcpClient();
    const result = await client.callTool({ name: toolName, arguments: args });
    const block = (result.content as { type: string; text?: string }[] | undefined)?.find(
      (c) => c.type === 'text' && typeof c.text === 'string',
    );
    console.log(`[zendeskMcp] ${toolName} → live Zendesk MCP`);
    return block?.text ? (JSON.parse(block.text) as Record<string, unknown>) : null;
  } catch (err) {
    console.error(
      `[zendeskMcp] ${toolName} failed, using curated fallback:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

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
  /** Recency — lets Support argue "tight cluster this week" (a spike) vs "spread over
   *  months" (background noise). A cluster of low createdDaysAgo is the spike signal. */
  createdDaysAgo?: number;
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
  /** Engineering's read of user impact — lets the shark argue severity, not just existence. */
  severity?: 'low' | 'medium' | 'high';
  /** Rough implementation cost — effort-vs-impact is Engineering's core judgment. */
  effort?: 'small' | 'medium' | 'large';
  labels?: string[];
  /** One-line engineering-relevant context (root cause, why it's backlogged, etc.). */
  note?: string;
}
export interface JiraSearchResult {
  issues: JiraIssue[];
}

// ---------------------------------------------------------------------------
// Slack real-time search (via Slack MCP server), SCOPED PER PERSONA.
//
// Each shark searches only its own channels, so it argues from its own sources
// and the three voices stay distinct — Engineering shouldn't be surfacing the
// #renewals churn thread (that's Support's lane), and having all three cite the
// same thread makes the debate redundant. Scoping is enforced by appending
// Slack `in:#channel` search operators to the query (OR'd across channels).
// ---------------------------------------------------------------------------
export const SLACK_CHANNEL_SCOPES = {
  support: ['support-escalations', 'renewals', 'voice-of-customer'],
  engineering: ['incidents', 'eng-triage', 'github-issues'],
  product: ['product-roadmap', 'product-decisions'],
} as const;

/** Build a Slack search tool optionally scoped to a set of channels. Same body
 *  for all; only the channel filter (and the tool name/description) differ. */
function makeSlackSearch(name: string, channels?: readonly string[]) {
  const scopeSuffix = channels?.length ? ' ' + channels.map((c) => `in:#${c}`).join(' ') : '';
  const scopeNote = channels?.length
    ? ` Searches only these channels: ${channels.map((c) => `#${c}`).join(', ')}.`
    : '';
  return defineTool<{ query: string }, SlackSearchResult>({
    name,
    description:
      `Search Slack messages for prior discussion related to a query.${scopeNote}` +
      ' Use to find whether this feedback has been raised before.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search terms / keywords.' } },
      required: ['query'],
    },
    async execute(input) {
      // PRIMARY: the Real-Time Search API (assistant.search.context) — Slack's
      // purpose-built endpoint for grounding an LLM with fresh in-workspace
      // context. Public search only (search:read.public), so channel_types
      // defaults to public_channel. We post-filter by channel_name for reliable
      // per-persona scoping (independent of whether `in:` operators are honored).
      try {
        const res = (await rtsClient().apiCall('assistant.search.context', {
          query: input.query,
          limit: 20,
        })) as { ok?: boolean; results?: { messages?: RtsMessage[] } };
        const messages = res.results?.messages ?? [];
        const scoped = channels?.length
          ? messages.filter((m) => channels.includes((m.channel_name ?? '').replace(/^#/, '')))
          : messages;
        // Log the channel_names RTS actually returned vs the persona's scope, so
        // an over-filtering "0 in scope" is diagnosable — is it a real miss, or a
        // name-format mismatch (IDs, leading '#', different casing)?
        const returnedChannels = [...new Set(messages.map((m) => m.channel_name ?? '?'))];
        console.log(
          `[rts] ${name}: assistant.search.context → ${messages.length} msgs` +
            (channels?.length ? `, ${scoped.length} in scope` : '') +
            ` | returned channels: [${returnedChannels.join(', ')}]` +
            (channels?.length ? ` | scope: [${channels.join(', ')}]` : ''),
        );
        if (scoped.length) {
          return {
            resultsText: scoped
              .slice(0, 5)
              .map(
                (m) =>
                  `#${m.channel_name} · ${m.author_name}: ${m.content}` +
                  (m.permalink ? ` <${m.permalink}|link>` : ''),
              )
              .join('\n'),
          };
        }
        return { resultsText: 'No results.' };
      } catch (rtsErr) {
        // FALLBACK (resilience only): the Slack MCP server's search tool, so a
        // scope/API hiccup on RTS can't silence a shark mid-debate. A flaky
        // search shouldn't reject the Promise.all in runFinnFlow.
        console.log(
          `[rts] ${name}: assistant.search.context failed → Slack MCP fallback:`,
          rtsErr instanceof Error ? rtsErr.message : rtsErr,
        );
        try {
          const client = await getSlackMcpClient();
          const result = await client.callTool({
            name: 'slack_search_public',
            arguments: { query: `${input.query}${scopeSuffix}`, limit: 5 },
          });
          const block = (result.content as { type: string; text?: string }[] | undefined)?.find(
            (c) => c.type === 'text' && typeof c.text === 'string',
          );
          if (!block?.text) return { resultsText: 'No results.' };
          const parsed = JSON.parse(block.text) as { results?: string };
          return { resultsText: parsed.results ?? 'No results.' };
        } catch {
          return { resultsText: `Slack search unavailable: ${(rtsErr as Error).message}` };
        }
      }
    },
  });
}

// Unscoped (general use — e.g. the activity summarizer) + one scoped tool per shark.
export const slackRtsSearch = makeSlackSearch('slackRtsSearch');
export const slackSearchSupport = makeSlackSearch('slackSearchSupport', SLACK_CHANNEL_SCOPES.support);
export const slackSearchEngineering = makeSlackSearch(
  'slackSearchEngineering',
  SLACK_CHANNEL_SCOPES.engineering,
);
export const slackSearchProduct = makeSlackSearch('slackSearchProduct', SLACK_CHANNEL_SCOPES.product);

// ---------------------------------------------------------------------------
// Zendesk (Vaultdesk MCP server)
// ---------------------------------------------------------------------------
// The SUPPORT shark's volume/recency instrument. Previously this returned a single
// generic "[STUB] ticket", so Support could never argue a real cluster or a spike.
// This catalog mirrors the seed/scenarios.ts Zendesk tickets and carries what Support
// argues from: how many, how recent (createdDaysAgo — a tight cluster is a spike), and
// which orgs. Curated keywords keep issues from bleeding into each other (the bug-spike
// recurring-GCal cluster and the sync-lag tickets both involve double-bookings, but must
// stay distinct). The ~30 unrelated distractors that make "N relevant out of many"
// credible live in the seeded Zendesk instance; the real MCP search (TODO) will surface
// them — this stub only returns the relevant matches by design.
interface CatalogZendeskTicket extends ZendeskTicket {
  keywords: string[];
}
const ZENDESK_CATALOG: CatalogZendeskTicket[] = [
  // ── bug-spike · recurring occurrences not written to Google Calendar (a fresh cluster) ──
  {
    id: 101,
    subject: 'Recurring meetings not syncing to Google Cal',
    description: 'Only the first occurrence of a recurring event lands in Google Calendar; the rest are confirmed but invisible.',
    status: 'open',
    org: 'BrightPath Studio',
    tags: ['google-calendar', 'recurring'],
    createdDaysAgo: 2,
    keywords: ['recurring', 'google calendar', 'google cal', 'repeats', 'not syncing', 'first occurrence'],
  },
  {
    id: 102,
    subject: 'Half my bookings missing from calendar since Tuesday',
    description: 'Bookings say confirmed but many never appear on Google Calendar — the repeating ones especially.',
    status: 'open',
    org: 'Northwind Traders',
    tags: ['google-calendar'],
    createdDaysAgo: 2,
    keywords: ['recurring', 'google calendar', 'repeats', 'missing from calendar', 'repeating', 'never appear'],
  },
  {
    id: 103,
    subject: 'Weekly standup invites stopped appearing in Google Calendar',
    description: 'Recurring standup invites stop showing on Google Calendar after the first week; two double-bookings already.',
    status: 'open',
    org: 'BrightPath Studio',
    tags: ['recurring', 'double-booking'],
    createdDaysAgo: 1,
    keywords: ['recurring', 'google calendar', 'standup', 'repeats', 'invites stopped', 'not appearing'],
  },
  {
    id: 104,
    subject: 'Google Calendar integration broken?',
    description: 'Bookings confirmed in-app but not on Google Calendar. Reconnecting the integration did nothing. Only repeat events.',
    status: 'open',
    tags: ['google-calendar', 'integration'],
    createdDaysAgo: 1,
    keywords: ['recurring', 'google calendar', 'repeats', 'not syncing', 'integration broken', 'repeat events'],
  },
  {
    id: 105,
    subject: 'URGENT - team double booking because calendar sync is dropping events',
    description: 'Recurring bookings confirmed but not written to Google Calendar, so the team keeps booking over each other.',
    status: 'open',
    tags: ['google-calendar', 'recurring', 'urgent'],
    createdDaysAgo: 0,
    keywords: ['recurring', 'google calendar', 'repeats', 'not syncing', 'dropping events', 'standup'],
  },
  // ── known-issue · Outlook/O365 invite offset by an hour ──
  {
    id: 110,
    subject: 'Outlook invite one hour off',
    description: "Clients booking on Outlook get an invite an hour earlier than the actual time; in-app shows the right time.",
    status: 'open',
    // Deliberately a HEALTHY account (not Ajax): known-issue is the dedup-restraint
    // scenario. On the at-risk Ajax account, accountContext flips this to a CSM
    // escalation (same as arr-judgment) and the "already tracked, just link it"
    // beat is lost. A healthy account keeps the verdict a clean dedup_link.
    org: 'BrightPath Studio',
    tags: ['office365', 'timezone'],
    createdDaysAgo: 6,
    keywords: ['outlook', 'office 365', 'o365', 'one hour', 'an hour', 'hour off', 'timezone', 'invite'],
  },
  // ── arr-judgment · embed layout shift (low volume; the account value carries it) ──
  {
    id: 120,
    subject: 'Embed causes layout shift on our site',
    description: 'The inline embed pushes page content around as it loads and is slow on mobile — above the fold on our homepage.',
    status: 'open',
    org: 'Ajax Corp',
    tags: ['embed', 'performance'],
    createdDaysAgo: 1,
    keywords: ['embed', 'layout shift', 'cls', 'janky', 'loads slowly', 'shoves', 'page around', 'conversion'],
  },
  // ── cheap-fix · tiny add-to-calendar affordance (single, low-value) ──
  {
    id: 130,
    subject: 'Add to calendar link easy to miss',
    description: 'The add-to-calendar link after booking is small and low-contrast; hard to spot on mobile. Would be nicer as a button.',
    status: 'open',
    org: 'Individual (Free)',
    tags: ['ui', 'mobile'],
    createdDaysAgo: 9,
    keywords: ['add to calendar', 'add-to-calendar', 'greyed out', 'low-contrast', 'easy to miss', 'tiny', 'button'],
  },
  // ── sync-override · stale availability / slow refresh (real, multi-customer) ──
  {
    id: 140,
    subject: 'Availability slow to update after a booking',
    description: 'The calendar shows slots as free for a few minutes after they are booked, so people double-book.',
    status: 'open',
    org: 'BrightPath Studio',
    tags: ['availability', 'sync'],
    createdDaysAgo: 4,
    keywords: ['stale availability', 'availability', 'slow to update', 'refresh', 'sync interval', 'showed as free'],
  },
  {
    id: 141,
    subject: 'Stale availability causing double bookings',
    description: 'There is a lag before the booking page reflects a new booking; a couple of clients grabbed a slot that was taken.',
    status: 'open',
    // HEALTHY account on purpose (was Northwind, at-risk $180k). sync-override is
    // the "hold the line on a declined non-goal → roadmap_reply" scenario. An
    // at-risk enterprise reporter drags Support into a churn escalation and the
    // judge's ACCOUNT-DRIVEN ESCALATION rule flips it to create_zendesk — making
    // it a duplicate of arr-judgment. Two healthy orgs keep the volume real
    // without a churn trigger. (Also retargeted the #renewals seed thread — see
    // seed/slack/seed.data.ts — which was the other Northwind leak into this.)
    org: 'Lumina',
    tags: ['availability', 'double-booking'],
    createdDaysAgo: 6,
    keywords: ['stale availability', 'availability', 'lag', 'reflect', 'tighten the sync', 'sync interval', 'refreshed'],
  },
];

export const zendeskSearchTickets = defineTool<
  { query: string; status?: string },
  ZendeskSearchResult
>({
  name: 'zendeskSearchTickets',
  description:
    'Search Zendesk tickets to quantify how many customers reported an issue, how recently, from which orgs, and read their phrasing. Use to gauge volume, spot a spike (a tight cluster), and read impact.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms describing the issue.' },
      status: { type: 'string', description: 'Optional status filter.' },
    },
    required: ['query'],
  },
  async execute(input) {
    // Real path: the Zendesk MCP server's full-text search over the sandbox.
    const mcp = await callZendeskMcp('search_tickets', { query: input.query ?? '' });
    if (mcp && Array.isArray(mcp.tickets)) {
      const tickets: ZendeskTicket[] = (mcp.tickets as Array<Record<string, unknown>>).map((t) => ({
        // Carry the REAL Zendesk id through — Support cites it as "Zendesk #<id>",
        // so a hardcoded 0 here is what made it render "#0".
        id: typeof t.id === 'number' ? t.id : Number(t.id) || 0,
        subject: String(t.subject ?? ''),
        description: String(t.description ?? ''),
        status: 'open',
        org: t.org ? String(t.org) : undefined,
        tags: Array.isArray(t.tags) ? (t.tags as string[]) : [],
        createdDaysAgo: typeof t.createdDaysAgo === 'number' ? t.createdDaysAgo : undefined,
      }));
      return { tickets };
    }
    // Fallback: curated keyword match over the local catalog.
    return { tickets: curatedTicketSearch(input.query ?? '') };
  },
});

/** Curated ticket search — the deterministic fallback when the Zendesk MCP
 *  server is unavailable. Matches the query against the catalog by keyword. */
function curatedTicketSearch(query: string): ZendeskTicket[] {
  const hay = query.toLowerCase();
  return ZENDESK_CATALOG.filter((t) => t.keywords.some((k) => hay.includes(k))).map((t) => ({
    id: t.id,
    subject: t.subject,
    description: t.description,
    status: t.status,
    org: t.org,
    tags: t.tags,
    createdDaysAgo: t.createdDaysAgo,
  }));
}

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
// The ENGINEERING shark's instrument. Previously this returned [] unconditionally,
// which made Engineering blind — it could only ever report "nothing tracked, file
// it," even when a matching issue existed (e.g. it missed KALA-980 in the ARR
// scenario while Product found it via roadmapLookup). This catalog mirrors the
// seed/scenarios.ts Jira issues and carries the fields Engineering actually argues
// from: issueType (Bug vs Story/Epic = defect vs enhancement), status, severity,
// effort, labels. Genuinely-untracked defects (bug-spike, cheap-fix) match nothing
// and correctly come back empty. TODO: replace with the Jira MCP/REST search.
interface CatalogJiraIssue extends JiraIssue {
  /** Curated match terms — kept precise so untracked scenarios stay empty. */
  keywords: string[];
}
const JIRA_CATALOG: CatalogJiraIssue[] = [
  {
    key: 'KALA-1487',
    summary: 'Office 365 booking invites offset by 1 hour for non-UTC organizers',
    issueType: 'Bug',
    status: 'In Progress',
    severity: 'high',
    effort: 'medium',
    labels: ['office365', 'timezone'],
    note: 'Confirmed DST-handling defect in the O365 invite writer; fix in review. Non-UTC organizers get invites an hour off.',
    keywords: ['office 365', 'o365', 'outlook', 'timezone', 'time zone', 'one hour', '1 hour', 'an hour off', 'offset', 'dst'],
  },
  {
    key: 'KALA-980',
    summary: 'Embed: reduce layout shift (CLS) and first-load performance',
    issueType: 'Story',
    status: 'Backlog',
    severity: 'low',
    effort: 'medium',
    labels: ['embed', 'performance', 'backlog'],
    note: 'Known long-tail perf item. Reserve space to avoid CLS, defer non-critical work. Low individual severity, broad but diffuse impact.',
    keywords: ['embed', 'layout shift', 'cls', 'janky', 'first-load', 'first load', 'shoves the page', 'page around'],
  },
  {
    key: 'KALA-1102',
    summary: 'Waitlist with auto-promotion for event types',
    issueType: 'Epic',
    status: 'To Do',
    severity: 'low',
    effort: 'large',
    labels: ['roadmap', 'feature-request'],
    note: 'Enhancement, not a defect. Planned on the roadmap; multiple inbound requests logged. Prioritization is Product\'s call.',
    keywords: ['waitlist', 'wait list', 'wait-list', 'fully booked', 'frees up', 'notify'],
  },
  {
    key: 'KALA-1495',
    summary: 'Real-time two-way calendar sync (replaces 5-min polling)',
    issueType: 'Epic',
    status: 'In Progress',
    severity: 'medium',
    effort: 'large',
    labels: ['roadmap', 'q3', 'sync'],
    note: 'Committed Q3 work: real-time two-way sync (webhook-based) replacing the 5-min polling model — the proper fix for staleness/sync-lag. Point-fixes discouraged until it lands.',
    keywords: ['stale availability', 'sync interval', 'sync-interval', 'two-way sync', 'polling', 'availability not updating', 'refresh interval', 'sync lag'],
  },
];

export const jiraSearchIssues = defineTool<{ jql: string }, JiraSearchResult>({
  name: 'jiraSearchIssues',
  description:
    'Search Jira issues to check whether a bug/feature is already tracked, and read its type/status/severity/effort. Use before proposing to create a new issue — link an existing one rather than duplicating.',
  inputSchema: {
    type: 'object',
    properties: {
      jql: { type: 'string', description: 'Search terms or a JQL query string describing the issue.' },
    },
    required: ['jql'],
  },
  async execute(input) {
    // TODO: call the Jira MCP server / REST search. Until then, match the query
    // against the catalog by curated keywords — precise enough that a genuinely
    // untracked defect (bug-spike recurring-GCal, cheap-fix) matches nothing and
    // comes back empty, which correctly drives "file it".
    const hay = (input.jql ?? '').toLowerCase();
    const issues: JiraIssue[] = JIRA_CATALOG.filter((item) =>
      item.keywords.some((k) => hay.includes(k)),
    ).map((item) => ({
      key: item.key,
      summary: item.summary,
      issueType: item.issueType,
      status: item.status,
      severity: item.severity,
      effort: item.effort,
      labels: item.labels,
      note: item.note,
    }));
    return { issues };
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

// ---------------------------------------------------------------------------
// Account context — the SUPPORT shark's instrument for weighing *who* is
// affected, not just how many. Volume/phrasing come from zendeskSearchTickets;
// this answers the business-stakes question the ARR-flip scenario turns on
// (plan, ARR, renewal proximity, health). Keeping it separate from ticket
// search means Support can argue account value even when ticket volume is low.
// ---------------------------------------------------------------------------
export interface AccountContext {
  org: string;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  arrUsd: number;
  renewalDate?: string;
  health?: 'healthy' | 'watch' | 'at-risk';
  /** One-line CSM/renewal signal the shark can quote directly. */
  note?: string;
}

// Canned account book, consistent with seed/scenarios.ts orgs + seed/slack
// history (Ajax, Northwind, BrightPath, Lumina). Keyed loosely so an org id
// ("org-ajax"), a name ("Ajax"), or an email/domain ("success@ajax.example")
// all resolve. TODO: wire to the Zendesk/CRM MCP server (org fields).
const ACCOUNTS: Record<string, AccountContext> = {
  ajax: {
    org: 'Ajax Corp',
    plan: 'enterprise',
    arrUsd: 48000,
    renewalDate: '2026-07-24',
    health: 'at-risk',
    note: 'Enterprise; renewal approaching; CS flagged health at-risk in the latest account review.',
  },
  northwind: {
    org: 'Northwind Traders',
    plan: 'enterprise',
    arrUsd: 180000,
    renewalDate: '2026-08-31',
    health: 'at-risk',
    note: 'Enterprise; large account; health at-risk — watch closely into the Aug renewal.',
  },
  brightpath: {
    org: 'BrightPath Studio',
    plan: 'team',
    arrUsd: 6000,
    health: 'healthy',
    note: 'Team plan, healthy account, no renewal pressure.',
  },
  lumina: {
    org: 'Lumina',
    plan: 'pro',
    arrUsd: 3000,
    health: 'healthy',
  },
  meridian: {
    org: 'Meridian Wellness',
    plan: 'team',
    arrUsd: 9000,
    health: 'healthy',
    note: 'Team plan, healthy account; heavy recurring-scheduling user.',
  },
};

const FREE_TIER: AccountContext = {
  org: 'Individual (Free)',
  plan: 'free',
  arrUsd: 0,
  health: 'healthy',
  note: 'No paid account attached — free tier, no ARR or renewal at stake.',
};

export const accountContext = defineTool<{ org: string }, AccountContext>({
  name: 'accountContext',
  description:
    "Look up an account's plan, ARR, renewal date, and health for the org that reported this feedback. Use to weigh WHO is affected (business stakes / churn risk), not just how many.",
  inputSchema: {
    type: 'object',
    properties: {
      org: {
        type: 'string',
        description: 'Org id, name, or a requester email/domain (e.g. "org-ajax", "Ajax", "success@ajax.example").',
      },
    },
    required: ['org'],
  },
  async execute(input) {
    // Real path: the Zendesk MCP server reads the org's custom fields
    // (arr_usd / renewal_date / health / plan). This is an exact lookup — no
    // fuzzy search — so it's deterministic and safe for the ARR flip.
    const mcp = await callZendeskMcp('get_organization', { name: input.org });
    if (mcp && mcp.found === true) {
      return {
        org: String(mcp.org ?? input.org),
        plan: asPlan(mcp.plan),
        arrUsd: typeof mcp.arrUsd === 'number' ? mcp.arrUsd : Number(mcp.arrUsd ?? 0) || 0,
        renewalDate: mcp.renewalDate ? String(mcp.renewalDate) : undefined,
        health: asHealth(mcp.health),
        note: mcp.note ? String(mcp.note) : undefined,
      };
    }
    // Fallback: the curated account book (also covers orgs not yet in Zendesk).
    return curatedAccountContext(input.org);
  },
});

/** Curated account lookup — deterministic fallback / coverage for orgs not
 *  seeded in Zendesk. Keyed loosely (id / name / email domain all resolve). */
function curatedAccountContext(org: string): AccountContext {
  const needle = org.toLowerCase();
  const hit = Object.entries(ACCOUNTS).find(([key]) => needle.includes(key));
  return hit ? hit[1] : FREE_TIER;
}

/** Coerce the MCP-returned plan/health strings into the typed unions, defaulting
 *  safely — the model output and the org fields are free-form strings. */
function asPlan(v: unknown): AccountContext['plan'] {
  const s = String(v ?? '').toLowerCase();
  return s === 'pro' || s === 'team' || s === 'enterprise' ? s : 'free';
}
function asHealth(v: unknown): AccountContext['health'] {
  const s = String(v ?? '').toLowerCase();
  return s === 'watch' || s === 'at-risk' ? s : 'healthy';
}

// ---------------------------------------------------------------------------
// Roadmap lookup — the PRODUCT shark's instrument. This is the tool the debate
// was missing: it answers strategic fit, opportunity cost, and capacity, NOT
// "is there a duplicate ticket." It surfaces the committed themes for the
// quarter, explicit non-goals ("we decided NOT to do X"), and whether the
// feedback maps to a planned item — so Product can argue direction rather than
// re-run Engineering's dedup search.
// ---------------------------------------------------------------------------
export interface RoadmapItem {
  key: string;
  summary: string;
  status: string;
  /** true = scheduled/committed; false = logged but not prioritized (backlog). */
  onRoadmap: boolean;
  note?: string;
}
export interface RoadmapSnapshot {
  quarter: string;
  committedThemes: { theme: string; item?: string; note?: string }[];
  /** Explicit "we are NOT doing this" decisions — the strongest Product argument. */
  explicitNonGoals: string[];
  /** Roadmap items matching the query (planned OR explicitly backlogged). */
  matchingItems: RoadmapItem[];
  capacityNote: string;
}

// Roadmap catalog, consistent with the product-roadmap / product-decisions
// Slack history in seed/slack/seed.data.ts. TODO: wire to the roadmap source
// (Jira roadmap board / product-docs MCP).
const ROADMAP_CATALOG: RoadmapItem[] = [
  {
    key: 'KALA-1102',
    summary: 'Waitlist with auto-promotion for event types',
    status: 'To Do',
    onRoadmap: true,
    note: 'Planned; multiple inbound requests already logged. Right move is a customer reply with the ETA + a +1, not a new ticket.',
  },
  {
    key: 'KALA-980',
    summary: 'Embed: reduce layout shift (CLS) and first-load perf',
    status: 'Backlog',
    onRoadmap: false,
    note: 'Backlogged long-tail; off the Q3 theme. Low individual severity, diffuse impact. No capacity before Q4 on strategy alone.',
  },
  {
    key: 'KALA-1495',
    summary: 'Real-time two-way calendar sync (replaces 5-min polling)',
    status: 'In Progress',
    onRoadmap: true,
    note: 'The sanctioned fix for staleness/sync-lag complaints. Point-fixes before it lands are discouraged.',
  },
];

export const roadmapLookup = defineTool<{ query: string }, RoadmapSnapshot>({
  name: 'roadmapLookup',
  description:
    'Look up product strategy for this feedback: the committed themes this quarter, explicit non-goals (things we decided NOT to build), whether it maps to a planned roadmap item, and remaining capacity. Use to weigh strategic fit and opportunity cost — NOT to dedup tickets.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords describing the feedback (e.g. "waitlist", "embed performance").' },
    },
    required: ['query'],
  },
  async execute(input) {
    // TODO: call the roadmap source (Jira roadmap board / product-docs MCP).
    const terms = input.query.toLowerCase().split(/\W+/).filter(Boolean);
    const matchingItems = ROADMAP_CATALOG.filter((item) => {
      const hay = `${item.summary} ${item.note ?? ''}`.toLowerCase();
      return terms.some((t) => hay.includes(t));
    });
    return {
      quarter: 'Q3 2026',
      committedThemes: [
        {
          theme: 'Real-time two-way calendar sync',
          item: 'KALA-1495',
          note: 'Replaces the 5-min polling model; the sanctioned fix for staleness complaints.',
        },
      ],
      explicitNonGoals: [
        'Per-user sync-interval overrides — a declared Q3 non-goal.',
        'Routing-rules revamp is a Q4 headline item, not Q3 — do not promise it for this quarter.',
      ],
      matchingItems,
      capacityNote:
        'Q3 engineering capacity is fully committed to two-way sync. No room for net-new scope before Q4 on strategy grounds alone.',
    };
  },
});

/** The full registry every agent draws from. Personas subset this by name. */
export const toolRegistry = createRegistry([
  slackRtsSearch,
  slackSearchSupport,
  slackSearchEngineering,
  slackSearchProduct,
  zendeskSearchTickets,
  zendeskCreateTicket,
  accountContext,
  jiraSearchIssues,
  jiraCreateIssue,
  roadmapLookup,
  slackPostMessage,
]);
