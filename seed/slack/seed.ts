import { PERSONAS, THREADS, SEEDED_CHANNELS } from "./seed.data.js";
import type { SeedThread } from "./seed.data.js";
import {
  ensureChannel,
  post,
  manifestExists,
  readManifest,
  writeManifest,
  hasFlag,
  flagValue,
  type Manifest,
  type ManifestEntry,
} from "./slackhelpers.js";

// Seed the context substrate. Idempotent by default: if a manifest already exists it
// refuses to run (so an accidental re-run doesn't double-post your distractors).
//
//   npx tsx scripts/seed.ts                 # seed once; no-op if already seeded
//   npx tsx scripts/seed.ts --force         # reseed anyway (pair with reset --all first)
//   npx tsx scripts/seed.ts --create        # create any missing public channels
//   npx tsx scripts/seed.ts --only bug_spike # (re)post just one scenario's threads
//
// Typical dev loop:  reset.ts --all   then   seed.ts --force
// Refresh the "today's spike" cluster before a demo:  seed.ts --only bug_spike

async function main(): Promise<void> {
  const force = hasFlag("force");
  const create = hasFlag("create");
  const only = flagValue("only"); // a tag, e.g. "bug_spike"

  if (manifestExists() && !force && !only) {
    console.log(
      "Manifest already present — workspace looks seeded. Use --force to reseed, " +
        "or --only <tag> to top up one scenario.",
    );
    return;
  }

  const threads: SeedThread[] = only ? THREADS.filter((t) => t.tag === only) : THREADS;
  if (only && threads.length === 0) {
    console.log(`No threads tagged "${only}". Tags: ${[...new Set(THREADS.map((t) => t.tag))].join(", ")}`);
    return;
  }

  // Resolve (and optionally create) every channel up front so we fail fast on setup.
  const channels = only ? [...new Set(threads.map((t) => t.channel))] : SEEDED_CHANNELS;
  console.log(`Resolving ${channels.length} channel(s)…`);
  const ids = new Map<string, string>();
  for (const name of channels) {
    ids.set(name, await ensureChannel(name, { create }));
  }

  const messages: ManifestEntry[] = [];
  console.log(`Posting ${threads.length} thread(s)…`);

  for (const thread of threads) {
    const channelId = ids.get(thread.channel)!;
    const parentTs = await post(channelId, PERSONAS[thread.persona], thread.text);
    messages.push({ tag: thread.tag, channelName: thread.channel, channel: channelId, ts: parentTs });

    for (const reply of thread.replies ?? []) {
      const replyTs = await post(channelId, PERSONAS[reply.persona], reply.text, parentTs);
      messages.push({
        tag: thread.tag,
        channelName: thread.channel,
        channel: channelId,
        ts: replyTs,
        threadTs: parentTs,
      });
    }
    console.log(`  ✓ #${thread.channel} [${thread.tag}] (+${thread.replies?.length ?? 0} replies)`);
  }

  // --only tops up an existing manifest rather than clobbering it.
  const manifest: Manifest = { version: 1, seededAt: new Date().toISOString(), messages };
  if (only && manifestExists()) {
    const existing = readManifest();
    manifest.messages = [...existing.messages, ...messages];
    manifest.seededAt = existing.seededAt;
  }

  writeManifest(manifest);
  console.log(`\nDone. ${messages.length} messages recorded in the manifest.`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});