import type { WebClient } from "@slack/web-api";
import type { Verdict, SharkRole } from "./types.js";
import { STANCE_REACTION } from "./emoji.js";

// Finn's decision ledger — a persistent channel canvas he appends to after every approved
// verdict, turning ephemeral thread decisions into a durable, searchable record of what
// was decided and why. Called from the approve handler, right after the action routes.
//
// Two write paths behind one interface:
//   • WebApiCanvasWriter — deterministic append via the Web API. This is the default and
//     the recommended one: appending a ledger row is deterministic, so it belongs on the
//     Web API for the same reason Finn's posts do, not in an LLM tool-use loop.
//   • McpCanvasWriter — a thin adapter for routing the write through the Slack MCP server's
//     canvas tools, only worth it if you specifically want the model to own the write for
//     MCP-integration credit. Wire the real tool names once you've loaded them.
//
// Canvas holds markdown only (no Block Kit), so this is the *record*; the interactive
// approve/reject stays in the Block Kit verdict card. Clean division of labor.

// ── The write surface ─────────────────────────────────────────────────────────
export interface CanvasWriter {
  /** Return the channel canvas id, creating it (with the ledger header) if absent. */
  getOrCreateChannelCanvas(channelId: string): Promise<string>;
  /** Append markdown to the end of the canvas. */
  appendMarkdown(canvasId: string, markdown: string): Promise<void>;
}

// ── Ledger entry + formatting ──────────────────────────────────────────────────
export interface LedgerEntry {
  verdict: Verdict;
  /** One-line summary of the feedback that triggered the debate. */
  feedbackSummary: string;
  /** approved -> a human OK'd it and the action executed; rejected -> a human
   *  overruled it, nothing ran; auto -> the panel reached consensus on a
   *  low-stakes call and Finn handled it without interrupting a human. */
  decision: "approved" | "rejected" | "auto";
  /** Display name of the human who decided. Canvas markdown doesn't resolve
   *  Slack's "<@U…>" mention syntax the way messages do, so this must already
   *  be a plain name (see resolveDisplayName in finnFlow.ts), not a mention. */
  decidedBy: string;
  /** Permalink back to the debate thread (chat.getPermalink). */
  threadPermalink?: string;
  at?: Date;
}

const LEDGER_HEADER =
  "# :finn: Finn — Decision Log\n" +
  "Every product-feedback call Finn has made in this channel, with the reasoning and the " +
  "action taken. Newest at the bottom.\n";

const ROLE_LABEL: Record<SharkRole, string> = {
  support: "Support",
  engineering: "Engineering",
  product: "Product",
};

/** Render one verdict as an appendable markdown section. Compact and scannable. */
export function formatEntry(entry: LedgerEntry): string {
  const date = (entry.at ?? new Date()).toISOString().slice(0, 10);
  const v = entry.verdict;

  const reads = (Object.keys(v.reads) as SharkRole[])
    .map((r) => `${ROLE_LABEL[r]} :${STANCE_REACTION[v.reads[r]]}:`)
    .join(" · ");

  const link = entry.threadPermalink ? ` · [view debate](${entry.threadPermalink})` : "";
  const callLine =
    entry.decision === "approved"
      ? `**Call:** ${v.action.label} · **Approved by** ${entry.decidedBy}${link}`
      : entry.decision === "auto"
        ? `**Call:** ${v.action.label} · **Handled autonomously** (panel consensus, low-stakes)${link}`
        : `**Call:** ${v.action.label} — overruled · **Rejected by** ${entry.decidedBy}${link}`;

  return (
    `### :finn: ${date} — ${v.headline}\n` +
    `**Feedback:** ${entry.feedbackSummary}\n` +
    `${callLine}\n` +
    `${v.rationale}\n` +
    `_${reads}_\n`
  );
}

// ── Top-level API ──────────────────────────────────────────────────────────────
/** Record an approved verdict in the channel's decision ledger. */
export async function recordVerdict(
  writer: CanvasWriter,
  channelId: string,
  entry: LedgerEntry,
): Promise<void> {
  const canvasId = await writer.getOrCreateChannelCanvas(channelId);
  await writer.appendMarkdown(canvasId, formatEntry(entry));
}

// ── Web API writer (recommended default) ────────────────────────────────────────
export class WebApiCanvasWriter implements CanvasWriter {
  private cache = new Map<string, string>(); // channelId -> canvasId
  // Slack auto-provisions a blank canvas for most channels before Finn ever
  // runs, so `lookupChannelCanvas` below usually finds an existing (empty,
  // header-less) canvas rather than hitting the `create` branch that writes
  // LEDGER_HEADER — this tracks which canvases we've backfilled the header
  // into, bounded to this warm process (worst case: header re-inserted once
  // more on a cold start, a harmless cosmetic duplicate).
  private headerEnsured = new Set<string>();

  constructor(private client: WebClient) {}

  async getOrCreateChannelCanvas(channelId: string): Promise<string> {
    const cached = this.cache.get(channelId);
    if (cached) return cached;

    // A channel has at most one canvas; reuse it if present.
    const existing = await this.lookupChannelCanvas(channelId);
    if (existing) {
      this.cache.set(channelId, existing);
      await this.ensureHeader(existing);
      return existing;
    }

    try {
      const res = await this.client.apiCall("conversations.canvases.create", {
        channel_id: channelId,
        document_content: { type: "markdown", markdown: LEDGER_HEADER },
      });
      const id = (res as { canvas_id?: string }).canvas_id;
      if (!id) throw new Error("conversations.canvases.create returned no canvas_id");
      this.cache.set(channelId, id);
      this.headerEnsured.add(id); // create() already wrote LEDGER_HEADER above
      return id;
    } catch (err) {
      // Lost a create race — someone else made it first. Fetch and use theirs.
      if (codeOf(err) === "channel_canvas_already_exists") {
        const again = await this.lookupChannelCanvas(channelId);
        if (again) {
          this.cache.set(channelId, again);
          await this.ensureHeader(again);
          return again;
        }
      }
      throw err;
    }
  }

  /** Backfill LEDGER_HEADER into a canvas we didn't create ourselves (Slack's
   *  auto-provisioned default, or one from a lost create race) — otherwise it
   *  never gets a title/heading at all. Runs at most once per canvasId per
   *  warm process. */
  private async ensureHeader(canvasId: string): Promise<void> {
    if (this.headerEnsured.has(canvasId)) return;
    this.headerEnsured.add(canvasId);
    await withEditRetry(async () => {
      const res = await this.client.apiCall("canvases.edit", {
        canvas_id: canvasId,
        changes: [
          { operation: "insert_at_start", document_content: { type: "markdown", markdown: LEDGER_HEADER } },
        ],
      });
      if (!(res as { ok?: boolean }).ok) throw asError(res);
    });
  }

  async appendMarkdown(canvasId: string, markdown: string): Promise<void> {
    // canvases.edit rejects concurrent edits — if two approvals land together, one gets an
    // "edit in progress" error. Retry with backoff so appends serialize cleanly.
    await withEditRetry(async () => {
      const res = await this.client.apiCall("canvases.edit", {
        canvas_id: canvasId,
        changes: [
          { operation: "insert_at_end", document_content: { type: "markdown", markdown } },
        ],
      });
      if (!(res as { ok?: boolean }).ok) throw asError(res);
    });
  }

  /** Read the channel's existing canvas file_id from conversations.info, if
   *  one exists. The real shape is `properties.tabs` — an array of tab
   *  objects, one of which has `type: "canvas"` and `data.file_id`. There is
   *  no `properties.canvas.file_id` field; verified directly against a live
   *  channel rather than assumed, since that field never existed and this
   *  method always returning undefined was silently causing a brand new
   *  canvas to be created on every single approve. */
  private async lookupChannelCanvas(channelId: string): Promise<string | undefined> {
    const info = await this.client.conversations.info({ channel: channelId });
    const tabs = (
      info.channel as
        | { properties?: { tabs?: Array<{ type?: string; data?: { file_id?: string } }> } }
        | undefined
    )?.properties?.tabs;
    return tabs?.find((t) => t.type === 'canvas')?.data?.file_id;
  }
}

// ── MCP writer (optional; wire real tool names before use) ───────────────────────
// A tool-caller you supply from your MCP client. It should invoke the named Slack MCP
// canvas tool and return its result. Signatures below are placeholders — confirm the
// actual tool names and argument shapes against your loaded Slack MCP tool list.
export type McpToolCaller = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ ok?: boolean; canvas_id?: string; error?: string }>;

export class McpCanvasWriter implements CanvasWriter {
  private cache = new Map<string, string>();

  constructor(
    private call: McpToolCaller,
    // Override these with the real tool names from your MCP client.
    private tools = {
      create: "conversations_canvases_create", // TODO: confirm
      edit: "canvases_edit", // TODO: confirm
    },
  ) {}

  async getOrCreateChannelCanvas(channelId: string): Promise<string> {
    const cached = this.cache.get(channelId);
    if (cached) return cached;
    const res = await this.call(this.tools.create, {
      channel_id: channelId,
      document_content: { type: "markdown", markdown: LEDGER_HEADER },
    });
    if (!res.canvas_id) throw new Error(`MCP canvas create failed: ${res.error ?? "unknown"}`);
    this.cache.set(channelId, res.canvas_id);
    return res.canvas_id;
  }

  async appendMarkdown(canvasId: string, markdown: string): Promise<void> {
    await withEditRetry(async () => {
      const res = await this.call(this.tools.edit, {
        canvas_id: canvasId,
        changes: [
          { operation: "insert_at_end", document_content: { type: "markdown", markdown } },
        ],
      });
      if (res.ok === false) throw new Error(res.error ?? "canvas edit failed");
    });
  }
}

// ── Retry + error helpers ────────────────────────────────────────────────────────
// The exact "edit in progress" error code isn't guaranteed stable, so match a candidate
// set AND a substring on the human-readable detail. Adjust the set once you've seen the
// real code from your SDK.
const TRANSIENT_EDIT_CODES = new Set([
  "canvas_edit_in_progress",
  "edit_in_progress",
  "canvas_locked",
]);

function isTransientEdit(err: unknown): boolean {
  const code = codeOf(err);
  if (code && TRANSIENT_EDIT_CODES.has(code)) return true;
  const hay = `${code ?? ""} ${detailOf(err)}`.toLowerCase();
  return hay.includes("in progress") || hay.includes("in_progress");
}

async function withEditRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientEdit(err) || attempt === tries) throw err;
      await sleep(300 * attempt); // linear backoff; WebClient handles 429s separately
    }
  }
  throw lastErr;
}

function codeOf(err: unknown): string | undefined {
  const e = err as { data?: { error?: string }; code?: string } | undefined;
  return e?.data?.error ?? e?.code;
}

function detailOf(err: unknown): string {
  const e = err as { data?: { detail?: string }; message?: string } | undefined;
  return e?.data?.detail ?? e?.message ?? "";
}

function asError(res: unknown): Error {
  const code = (res as { error?: string }).error ?? "unknown_error";
  const err = new Error(`canvases.edit failed: ${code}`);
  (err as { data?: unknown }).data = res;
  return err;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));