import type { WebClient } from "@slack/web-api";
import type { SharkTurn } from "./types.js";
import { THINKING, STANCE_REACTION } from "./emoji.js";

// Finn's reaction arc — the signature demo moment.
//
//   1. thinkAbout()  -> Finn drops 🤔 on a shark message the instant it posts.
//   2. resolve()     -> after the judge pass, 🤔 becomes 👍 / 👎 / ⚖️ per shark.
//
// Reactions are Finn's presence in the debate *before* he posts the verdict. Keep the
// timing deliberate in the demo: let the 🤔s stack, pause, then resolve them, then post
// the card. That pause is the ~0:45 lean-in beat.

/**
 * React with 🤔 to a shark's message. Call this as each shark posts, not in a batch —
 * the staggered reactions are what create the "Finn is following along" feel.
 */
export async function thinkAbout(
  client: WebClient,
  channel: string,
  messageTs: string,
): Promise<void> {
  await addReaction(client, channel, messageTs, THINKING);
}

/**
 * Resolve the debate: for each shark, swap 🤔 for Finn's read (👍/👎/⚖️).
 *
 * Requires every turn to have a `stance` set (from the judge output) and the `messageTs`
 * captured when the shark posted. Runs the swaps concurrently but each swap removes 🤔
 * before adding the resolved glyph so the thread never shows two Finn reactions at once.
 *
 * Optionally pass `settleMs` to stagger the reveals for the video (e.g. 600ms) so judges
 * watch the reactions flip one by one rather than all at once.
 */
export async function resolveReactions(
  client: WebClient,
  channel: string,
  turns: SharkTurn[],
  opts: { settleMs?: number } = {},
): Promise<void> {
  for (const turn of turns) {
    if (!turn.stance) continue; // leave 🤔 on anything genuinely unresolved by the judge
    await removeReaction(client, channel, turn.messageTs, THINKING);
    await addReaction(client, channel, turn.messageTs, STANCE_REACTION[turn.stance]);
    if (opts.settleMs) await sleep(opts.settleMs);
  }
}

// --- Slack API wrappers -----------------------------------------------------
// reactions.add throws `already_reacted` and reactions.remove throws `no_reaction`
// when the state is already what you asked for. Both are benign for our purposes, so
// we swallow exactly those and let anything else surface.

async function addReaction(
  client: WebClient,
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp, name });
  } catch (err) {
    if (!isSlackError(err, "already_reacted")) throw err;
  }
}

async function removeReaction(
  client: WebClient,
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp, name });
  } catch (err) {
    if (!isSlackError(err, "no_reaction")) throw err;
  }
}

function isSlackError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "data" in err &&
    (err as { data?: { error?: string } }).data?.error === code
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));