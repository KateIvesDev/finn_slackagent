import { WebClient } from "@slack/web-api";
import fs from "node:fs";
import path from "node:path";
 
// ── Client ───────────────────────────────────────────────────────────────────
// Needs a BOT token (xoxb-). The bot deletes its *own* messages in reset.ts, so the
// same token seeds and tears down — no user token required.
//
// Scopes: channels:read, channels:join, chat:write, chat:write.customize,
//         channels:history (for reset --stage), and channels:manage (only if you want
//         seed.ts to create missing public channels for you).

const token = process.env.SLACK_SEED_BOT_TOKEN;
if (!token) {
  throw new Error("Set SLACK_BOT_TOKEN (xoxb-...) in your environment before running.");
}

export const client = new WebClient(token, { retryConfig: { retries: 5 } });

// Gentle spacing between write calls. WebClient already retries on 429; this just keeps
// us well under Slack's per-channel posting cadence so we rarely hit it.
const PACE_MS = Number(process.env.SEED_PACE_MS ?? 350);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Identity ──────────────────────────────────────────────────────────────────
let cachedBotId: string | undefined;
/** The app's bot_id — used by reset to delete only messages this app authored. */
export async function botId(): Promise<string | undefined> {
  if (cachedBotId) return cachedBotId;
  const auth = (await client.auth.test()) as { bot_id?: string };
  cachedBotId = auth.bot_id;
  return cachedBotId;
}

// ── Channel resolution ────────────────────────────────────────────────────────
let channelMap: Map<string, string> | null = null;

async function loadChannels(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const res = await client.conversations.list({
      limit: 200,
      cursor,
      exclude_archived: true,
      types: "public_channel,private_channel",
    });
    for (const c of res.channels ?? []) {
      if (c.id && c.name) map.set(c.name, c.id);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return map;
}

/**
 * Resolve a channel name to its ID, creating it (public) if missing and `create` is set,
 * then making sure the bot is a member so it can post.
 */
export async function ensureChannel(
  name: string,
  opts: { create?: boolean } = {},
): Promise<string> {
  if (!channelMap) channelMap = await loadChannels();
  let id = channelMap.get(name);

  if (!id && opts.create) {
    const created = await client.conversations.create({ name });
    id = created.channel?.id;
    if (id) channelMap.set(name, id);
    console.log(`  + created #${name}`);
  }
  if (!id) {
    throw new Error(`Channel #${name} not found. Create it in Slack, or run with --create.`);
  }

  // Join public channels so chat.write works. Harmless if already a member; private
  // channels can't be self-joined — invite the bot manually there.
  try {
    await client.conversations.join({ channel: id });
  } catch (err) {
    if (!isSlackError(err, "method_not_supported_for_channel_type", "already_in_channel")) {
      throw err;
    }
  }
  return id;
}

// ── Posting ───────────────────────────────────────────────────────────────────
export interface Persona {
  username: string;
  icon: string;
}

/** Post a message as a persona. Returns the ts. Paced to stay under rate limits. */
export async function post(
  channel: string,
  persona: Persona,
  text: string,
  threadTs?: string,
): Promise<string> {
  const res = await client.chat.postMessage({
    channel,
    text,
    username: persona.username,
    icon_emoji: persona.icon,
    thread_ts: threadTs,
  });
  await sleep(PACE_MS);
  return res.ts as string;
}

// ── Manifest ──────────────────────────────────────────────────────────────────
// Records every message we post so reset can delete exactly those — no orphans, no
// guessing at thread-parent cascade behavior.

export const MANIFEST_PATH = path.resolve(
  process.env.SEED_MANIFEST ?? path.join(__dirname, "seed.manifest.json"),
);

export interface ManifestEntry {
  tag: string;
  channelName: string;
  channel: string; // id
  ts: string;
  threadTs?: string; // set on replies
}

export interface Manifest {
  version: 1;
  seededAt: string;
  messages: ManifestEntry[];
}

export function manifestExists(): boolean {
  return fs.existsSync(MANIFEST_PATH);
}

export function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

export function writeManifest(m: Manifest): void {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

export function deleteManifest(): void {
  if (manifestExists()) fs.rmSync(MANIFEST_PATH);
}

// ── Deletion ──────────────────────────────────────────────────────────────────
/** Delete one message, swallowing the benign "already gone / can't delete" cases. */
export async function del(channel: string, ts: string): Promise<void> {
  try {
    await client.chat.delete({ channel, ts });
    await sleep(PACE_MS);
  } catch (err) {
    if (!isSlackError(err, "message_not_found", "cant_delete_message")) throw err;
  }
}

// ── Small util ────────────────────────────────────────────────────────────────
export function isSlackError(err: unknown, ...codes: string[]): boolean {
  const code =
    typeof err === "object" && err !== null && "data" in err
      ? (err as { data?: { error?: string } }).data?.error
      : undefined;
  return code !== undefined && codes.includes(code);
}

export function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

export function flagValue(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(pref));
  return hit?.slice(pref.length);
}