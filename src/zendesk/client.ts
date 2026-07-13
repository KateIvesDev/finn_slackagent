/**
 * Thin Zendesk REST client — the real external data source behind the Zendesk
 * MCP server (src/mcp-server/zendeskServer.ts) and the sandbox seeder
 * (seed/seed.ts). No SDK; just fetch + basic auth against a sandbox subdomain.
 *
 * Auth is HTTP Basic with `${email}/token:${apiToken}` (Zendesk's API-token
 * scheme). Creds come from env via config — never hardcoded.
 *
 * The org custom fields we read/write (create these in Zendesk first — see
 * README / the ARR-flip scenario): arr_usd, renewal_date, health, plan.
 */
import { loadConfig } from '../config/index.js';

/** A ticket as the agents care about it — flattened from Zendesk's shape. */
export interface ZdTicket {
  id: number;
  subject: string;
  description: string;
  tags: string[];
  createdAt: string; // ISO
  organizationId?: number;
}

/** An org with its custom fields flattened out of `organization_fields`. */
export interface ZdOrg {
  id: number;
  name: string;
  plan?: string;
  arrUsd?: number;
  renewalDate?: string;
  health?: string;
  /** Free-text CSM/renewal signal — Zendesk's built-in org `notes`. */
  notes?: string;
}

interface RawOrg {
  id: number;
  name: string;
  notes?: string;
  organization_fields?: Record<string, unknown>;
}

interface RawTicket {
  id: number;
  subject: string;
  description: string;
  tags?: string[];
  created_at: string;
  organization_id?: number;
}

/** Flatten a raw Zendesk ticket into the shape the agents consume. */
function mapTicket(t: RawTicket): ZdTicket {
  return {
    id: t.id,
    subject: t.subject,
    description: t.description,
    tags: t.tags ?? [],
    createdAt: t.created_at,
    organizationId: t.organization_id,
  };
}

// Common words that carry no search signal — dropped before per-keyword fan-out
// so "the calendar didn't refresh" searches on calendar/refresh, not the/didnt.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'for', 'and', 'or', 'but', 'not', 'no', 'it', 'its', 'we', 'our', 'us',
  'that', 'this', 'with', 'as', 'at', 'by', 'from', 'has', 'have', 'had', 'did',
  'does', 'do', 'already', 'still', 'when', 'after', 'before', 'because', 'so',
]);

/** Pull the salient search terms out of a natural-language query. */
function extractKeywords(query: string): string[] {
  const seen = new Set<string>();
  for (const w of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 2 && !STOPWORDS.has(w)) seen.add(w);
  }
  return [...seen];
}

export class ZendeskClient {
  private readonly base: string;
  private readonly auth: string;
  // Cache org id -> resolved org so ticket search doesn't re-fetch the same org.
  private readonly orgCache = new Map<number, ZdOrg>();

  constructor(subdomain: string, email: string, apiToken: string) {
    this.base = `https://${subdomain}.zendesk.com/api/v2`;
    // Buffer.from is fine on Node 20; base64 the `email/token:apiToken` pair.
    this.auth = 'Basic ' + Buffer.from(`${email}/token:${apiToken}`).toString('base64');
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: this.auth,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Zendesk ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    // 204 (no content) on some updates.
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
  }

  private flattenOrg(raw: RawOrg): ZdOrg {
    const f = raw.organization_fields ?? {};
    const num = (v: unknown): number | undefined =>
      v === null || v === undefined || v === '' ? undefined : Number(v);
    const str = (v: unknown): string | undefined =>
      v === null || v === undefined || v === '' ? undefined : String(v);
    return {
      id: raw.id,
      name: raw.name,
      plan: str(f.plan),
      arrUsd: num(f.arr_usd),
      renewalDate: str(f.renewal_date),
      health: str(f.health),
      notes: str(raw.notes),
    };
  }

  // ── Reads (used by the MCP server) ───────────────────────────────────────

  /**
   * Full-text ticket search, resilient to natural-language queries.
   *
   * Zendesk's `/search.json` ANDs every word, so a shark's descriptive query
   * ("stale availability calendar sync refresh booked slot already taken")
   * matches zero tickets even when relevant ones exist. So: try the whole query
   * first (precise when it hits), and if it comes back empty, fan out — search
   * each salient keyword on its own, union the hits, and rank by how many of the
   * query's keywords each ticket actually contains (most-relevant first).
   */
  async searchTickets(query: string): Promise<ZdTicket[]> {
    const direct = await this.rawSearch(query);
    if (direct.length > 0) return direct.map(mapTicket);

    const keywords = extractKeywords(query);
    if (keywords.length === 0) return [];

    // Union per-keyword hits, deduped by id.
    const byId = new Map<number, RawTicket>();
    const perKeyword = await Promise.all(keywords.map((k) => this.rawSearch(k)));
    for (const hits of perKeyword) {
      for (const t of hits) byId.set(t.id, t);
    }

    // Rank by keyword coverage over subject+description.
    const scored = [...byId.values()].map((t) => {
      const hay = `${t.subject} ${t.description}`.toLowerCase();
      const score = keywords.reduce((n, k) => (hay.includes(k) ? n + 1 : n), 0);
      return { t, score };
    });
    scored.sort((a, b) => b.score - a.score);

    // Drop single-keyword noise once at least one ticket matches 2+ keywords —
    // keeps the count honest (Support argues "N tickets / N orgs" off this).
    const maxScore = scored[0]?.score ?? 0;
    const floor = maxScore >= 2 ? 2 : 1;
    return scored
      .filter(({ score }) => score >= floor)
      .slice(0, 8)
      .map(({ t }) => mapTicket(t));
  }

  /** One raw `type:ticket` search — the AND-everything primitive the above builds on. */
  private async rawSearch(query: string): Promise<RawTicket[]> {
    const q = encodeURIComponent(`type:ticket ${query}`);
    const data = await this.request<{ results: RawTicket[] }>(`/search.json?query=${q}`);
    return data.results ?? [];
  }

  /** Fetch an org by id (cached), with its custom fields flattened. */
  async getOrganization(id: number): Promise<ZdOrg | null> {
    const cached = this.orgCache.get(id);
    if (cached) return cached;
    const data = await this.request<{ organization: RawOrg }>(`/organizations/${id}.json`);
    if (!data?.organization) return null;
    const org = this.flattenOrg(data.organization);
    this.orgCache.set(id, org);
    return org;
  }

  /** Find an org by (partial) name — used by accountContext's needle lookup. */
  async findOrganizationByName(needle: string): Promise<ZdOrg | null> {
    const q = encodeURIComponent(`type:organization ${needle}`);
    const data = await this.request<{ results: RawOrg[] }>(`/search.json?query=${q}`);
    const hit = (data.results ?? [])[0];
    return hit ? this.flattenOrg(hit) : null;
  }

  // ── Writes (used by the seeder) ──────────────────────────────────────────

  /** Create or update an org keyed by external_id, setting the custom fields. */
  async upsertOrganization(input: {
    externalId: string;
    name: string;
    plan?: string;
    arrUsd?: number;
    renewalDate?: string;
    health?: string;
    notes?: string;
  }): Promise<number> {
    const organization = {
      name: input.name,
      external_id: input.externalId,
      notes: input.notes,
      organization_fields: {
        plan: input.plan,
        arr_usd: input.arrUsd,
        renewal_date: input.renewalDate,
        health: input.health,
      },
    };
    const found = await this.request<{ results: RawOrg[] }>(
      `/search.json?query=${encodeURIComponent(`type:organization external_id:${input.externalId}`)}`,
    );
    const existing = (found.results ?? [])[0];
    if (existing) {
      await this.request(`/organizations/${existing.id}.json`, {
        method: 'PUT',
        body: JSON.stringify({ organization }),
      });
      return existing.id;
    }
    const created = await this.request<{ organization: RawOrg }>(`/organizations.json`, {
      method: 'POST',
      body: JSON.stringify({ organization }),
    });
    return created.organization.id;
  }

  /** Create or reuse an end user (by email), optionally attached to an org. */
  async upsertUser(email: string, name: string, organizationId?: number): Promise<number> {
    const created = await this.request<{ user: { id: number } }>(`/users/create_or_update.json`, {
      method: 'POST',
      body: JSON.stringify({ user: { email, name, organization_id: organizationId, verified: true } }),
    });
    return created.user.id;
  }

  /**
   * Create a ticket via the Ticket Import endpoint, keyed by external_id for
   * idempotency. Import (not the normal create) is used because it HONORS
   * `created_at` — the scenarios rely on ticket age (a fresh cluster = a spike;
   * a lone 9-day-old ticket = background noise), which plain create would flatten
   * to "now". `createdDaysAgo` backdates created_at accordingly.
   */
  async createTicket(input: {
    externalId: string;
    subject: string;
    description: string;
    requesterId: number;
    organizationId?: number;
    tags?: string[];
    createdDaysAgo?: number;
  }): Promise<number> {
    const found = await this.request<{ results: RawTicket[] }>(
      `/search.json?query=${encodeURIComponent(`type:ticket external_id:${input.externalId}`)}`,
    );
    const existing = (found.results ?? [])[0];
    if (existing) return existing.id;

    const createdAt = new Date(
      Date.now() - (input.createdDaysAgo ?? 0) * 86_400_000,
    ).toISOString();

    const created = await this.request<{ ticket: { id: number } }>(`/imports/tickets.json`, {
      method: 'POST',
      body: JSON.stringify({
        ticket: {
          external_id: input.externalId,
          subject: input.subject,
          // Import wants the body on comments[], with its own created_at.
          comments: [{ value: input.description, created_at: createdAt }],
          requester_id: input.requesterId,
          organization_id: input.organizationId,
          tags: input.tags,
          status: 'open',
          created_at: createdAt,
        },
      }),
    });
    return created.ticket.id;
  }
}

/** Build a client from env (throws a readable error if creds are missing). */
export function zendeskFromEnv(): ZendeskClient {
  const cfg = loadConfig();
  if (!cfg.ZENDESK_SUBDOMAIN || !cfg.ZENDESK_EMAIL || !cfg.ZENDESK_API_TOKEN) {
    throw new Error('Zendesk creds missing: set ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN.');
  }
  return new ZendeskClient(cfg.ZENDESK_SUBDOMAIN, cfg.ZENDESK_EMAIL, cfg.ZENDESK_API_TOKEN);
}
