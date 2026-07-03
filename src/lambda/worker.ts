/**
 * The worker Lambda — invoked asynchronously by src/lambda/receiver.ts with a
 * WorkTask payload. This is where the actual multi-agent debate/judge/execute
 * flow runs, free of any 3-second-ack deadline (that constraint applies to
 * the receiver's HTTP response, not to this async invocation).
 *
 * Deployed by Terraform (infra/lambda.tf) as `slackagent-worker`.
 */
import { WebClient } from '@slack/web-api';
import { loadConfig, requireConfig } from '../config/index.js';
import { runTask } from '../slack/taskRunner.js';
import { DynamoVerdictStore } from '../slack/verdictStore.js';
import type { WorkTask } from '../slack/types.js';

requireConfig(['SLACK_BOT_TOKEN']);
const cfg = loadConfig();

// Built once per execution environment (Lambda reuses warm environments
// across invocations), not per invocation.
const client = new WebClient(cfg.SLACK_BOT_TOKEN);
const store = new DynamoVerdictStore();

export async function handler(task: WorkTask): Promise<void> {
  try {
    await runTask(client, store, task);
  } catch (err) {
    console.error('Worker task failed:', task.type, err);
    // Best-effort error reply — only possible for tasks that carry a
    // feedback/channel to reply into.
    if (task.type === 'run_finn_flow') {
      await client.chat.postMessage({
        channel: task.feedback.channel,
        thread_ts: task.feedback.threadTs,
        text: `⚠️ Something broke while triaging: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}
