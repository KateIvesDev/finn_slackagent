import { WebClient } from "@slack/web-api";
import {
  del,
  manifestExists,
  readManifest,
  deleteManifest,
  ensureChannel,
  hasFlag,
  flagValue,
  sleep,
} from "./slackhelpers.js";

// Two independent things to reset between demo runs:
//
//   --all    Delete the seeded CONTEXT SUBSTRATE (seed.data.ts threads posted by
//            seed.ts) using the manifest, then delete the manifest itself. Uses the
//            seed bot's own token/client — a bot can only delete messages it posted.
//
//   --stage  Wipe the LIVE DEBATE STAGE (the feedback channel where Finn + the sharks
//            post at demo time). That content is NOT in the seed manifest — Finn and
//            the sharks generate it live — so this mode scans recent channel history
//            instead, using FINN's own token (SLACK_BOT_TOKEN), because Slack only
//            lets a bot delete messages posted by its own app, even when the shark
//            nameplates override the display name/icon via chat.write.customize.
//
// Run either or both:  npx tsx seed/slack/reset.ts --all --stage
// Override the stage channel:  npx tsx seed/slack/reset.ts --stage --channel=customer-feedback

async function resetAll(): Promise<void> {
  if (!manifestExists()) {
    console.log("--all: no manifest found, nothing to reset.");
    return;
  }
  const manifest = readManifest();
  console.log(`--all: deleting ${manifest.messages.length} seeded message(s)…`);

  // Delete replies before parents isn't required by the API, but doing parents
  // last avoids racing a "thread parent already gone" edge case in weird retries.
  const replies = manifest.messages.filter((m) => m.threadTs);
  const parents = manifest.messages.filter((m) => !m.threadTs);

  for (const m of [...replies, ...parents]) {
    await del(m.channel, m.ts);
  }

  deleteManifest();
  console.log("--all: done. Manifest cleared.");
}

async function resetStage(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("--stage requires SLACK_BOT_TOKEN (Finn's bot token) in the environment.");
  }
  const finn = new WebClient(token, { retryConfig: { retries: 5 } });
  const finnBotId = (await finn.auth.test() as { bot_id?: string }).bot_id;

  const channelName = flagValue("channel") ?? process.env.SLACK_FEEDBACK_CHANNEL_NAME;
  const channelId = channelName
    ? await ensureChannel(channelName)
    : process.env.SLACK_FEEDBACK_CHANNEL;
  if (!channelId) {
    throw new Error(
      "--stage: no channel to clear. Pass --channel=<name>, or set SLACK_FEEDBACK_CHANNEL " +
        "(id) / SLACK_FEEDBACK_CHANNEL_NAME (name) in the environment.",
    );
  }

  console.log(`--stage: scanning ${channelId} for Finn's messages…`);
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const res = await finn.conversations.history({ channel: channelId, cursor, limit: 200 });
    for (const msg of res.messages ?? []) {
      const ts = msg.ts;
      if (!ts) continue;

      if (msg.bot_id === finnBotId) {
        await del(channelId, ts);
        deleted++;
      }

      // Walk replies too — sharks post threaded under Finn's opener.
      if (msg.reply_count && msg.reply_count > 0) {
        const thread = await finn.conversations.replies({ channel: channelId, ts, limit: 200 });
        for (const reply of thread.messages ?? []) {
          if (reply.ts && reply.ts !== ts && reply.bot_id === finnBotId) {
            await del(channelId, reply.ts);
            deleted++;
          }
        }
        await sleep(150);
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  console.log(`--stage: done. Deleted ${deleted} message(s).`);
}

async function main(): Promise<void> {
  const all = hasFlag("all");
  const stage = hasFlag("stage");

  if (!all && !stage) {
    console.log("Nothing to do — pass --all (seeded context substrate) and/or --stage (live demo channel).");
    return;
  }

  if (all) await resetAll();
  if (stage) await resetStage();
}

main().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
