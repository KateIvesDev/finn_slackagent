/**
 * Clear Finn's side of a DM (the app's Messages tab), for a clean demo.
 *
 * Slack has no bulk "clear history" for an app DM, and a bot can only delete
 * its OWN messages — not the human's. So this deletes every message Finn
 * posted in the DM and reports how many of YOUR messages remain (those you'd
 * delete by hand: hover → ⋯ → Delete).
 *
 * Usage:
 *   npm run reset:dm -- U0123456789     # your Slack member ID (Profile → ⋯ → Copy member ID)
 *   npm run reset:dm -- D0123456789     # or the DM channel ID directly
 *
 * Needs SLACK_BOT_TOKEN in .env (the same token Finn runs under). The token's
 * app must have chat:write; deletes are best-effort (already-deleted / not-mine
 * messages are skipped).
 */
import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error('SLACK_BOT_TOKEN is not set (see .env).');
  process.exit(1);
}
const arg = process.argv[2];
if (!arg) {
  console.error('Pass your member ID (U…/W…) or the DM channel ID (D…).');
  console.error('  npm run reset:dm -- U0123456789');
  process.exit(1);
}

const client = new WebClient(token);

async function resolveImChannel(idOrUser: string): Promise<string> {
  // A DM channel id starts with D; anything else is treated as a user id and
  // opened into its IM channel (idempotent — returns the existing one).
  if (idOrUser.startsWith('D')) return idOrUser;
  const res = await client.conversations.open({ users: idOrUser });
  const id = res.channel?.id;
  if (!id) throw new Error(`Could not open a DM with ${idOrUser}.`);
  return id;
}

let deleted = 0;
let skippedNotMine = 0;

/** Try to delete one message; count whether it went (Finn's) or couldn't (yours). */
async function tryDelete(channel: string, ts: string): Promise<void> {
  try {
    await client.chat.delete({ channel, ts });
    deleted++;
  } catch (e) {
    // cant_delete_message = it's the human's message (or already gone).
    const code = (e as { data?: { error?: string } })?.data?.error;
    if (code === 'cant_delete_message' || code === 'message_not_found') skippedNotMine++;
    else throw e;
  }
}

/** Delete every reply in a thread (Finn's streamed answers live here, NOT in
 *  conversations.history), then let the caller handle the parent. */
async function clearThreadReplies(channel: string, parentTs: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await client.conversations.replies({ channel, ts: parentTs, cursor, limit: 200 });
    for (const reply of page.messages ?? []) {
      if (!reply.ts || reply.ts === parentTs) continue; // parent handled separately
      await tryDelete(channel, reply.ts);
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

async function main(): Promise<void> {
  const channel = await resolveImChannel(arg);
  let cursor: string | undefined;

  do {
    const page = await client.conversations.history({ channel, cursor, limit: 200 });
    for (const msg of page.messages ?? []) {
      if (!msg.ts) continue;
      // Thread replies (Finn's streamed responses) aren't in history — walk them
      // first, then delete the parent (deleting a parent can orphan its replies).
      if (msg.reply_count && msg.reply_count > 0) {
        await clearThreadReplies(channel, msg.ts);
      }
      await tryDelete(channel, msg.ts);
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  console.log(`Deleted ${deleted} of Finn's message(s) from ${channel}.`);
  if (skippedNotMine > 0) {
    console.log(
      `${skippedNotMine} message(s) left — those are yours; delete by hand (hover → ⋯ → Delete).`,
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
