/**
 * Socket Mode entrypoint — LOCAL DEV ONLY. No public URL needed, so it's the
 * fast loop for iterating on the Finn flow against a real Slack workspace.
 *
 * The judge-facing deployment runs over the HTTP Events API instead (API
 * Gateway → src/lambda/receiver.ts → src/lambda/worker.ts) — see
 * infra/README or CLAUDE.md for why. Both entrypoints share the exact same
 * listener/task logic (src/slack/listeners.ts, src/slack/taskRunner.ts);
 * this file only supplies the Socket Mode receiver, an in-memory
 * VerdictStore, and a `dispatch` that runs tasks inline (fine here — a
 * long-lived process has no 3-second-ack deadline on the actual work, unlike
 * Lambda).
 *
 * Run with: `npm run dev`
 */
import bolt from '@slack/bolt';
import { loadConfig, requireConfig } from '../config/index.js';
import { registerListeners } from './listeners.js';
import { runTask } from './taskRunner.js';
import { InMemoryVerdictStore } from './verdictStore.js';

const { App } = bolt;

// Fail fast if Slack creds are missing.
requireConfig(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
const cfg = loadConfig();

const app = new App({
  token: cfg.SLACK_BOT_TOKEN,
  appToken: cfg.SLACK_APP_TOKEN,
  socketMode: true, // <- key for local dev; connects outbound, no ngrok needed
});

const store = new InMemoryVerdictStore();

registerListeners(app, (task) =>
  runTask(app.client, store, task).catch(async (err) => {
    console.error('Task failed:', task.type, err);
    // Best-effort error reply in the thread — only possible for tasks that
    // carry a feedback/channel to reply into.
    if (task.type === 'run_finn_flow') {
      await app.client.chat.postMessage({
        channel: task.feedback.channel,
        thread_ts: task.feedback.threadTs,
        text: `⚠️ Something broke while triaging: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }),
);

const PORT = Number(process.env.PORT ?? 3000);
await app.start(PORT);
console.log('⚡️ Finn is running in Socket Mode (local dev).');
