/**
 * Maps a WorkTask to the finnFlow function that actually does it. This is the
 * one piece of logic shared, byte-for-byte, between Socket Mode (called
 * directly, in-process) and Lambda (called inside the async-invoked worker)
 * — see the WorkTask doc comment in src/slack/types.ts for why the split
 * exists at all.
 */
import type { WebClient } from '@slack/web-api';
import type { WorkTask } from './types.js';
import type { VerdictStore } from './verdictStore.js';
import {
  runFinnFlow,
  handleApprove,
  handleReject,
  publishFinnHome,
  handleRunScenario,
  handleFeedbackSubmit,
  handleSummarizeActivity,
  handleAssistantHelp,
} from './finnFlow.js';
import { runFinnFlowStreamed } from './finnFlowStreamed.js';

export async function runTask(client: WebClient, store: VerdictStore, task: WorkTask): Promise<void> {
  switch (task.type) {
    case 'run_finn_flow':
      return runFinnFlow(client, store, task.feedback);
    case 'assistant_message':
      return runFinnFlowStreamed(client, store, task.feedback);
    case 'summarize_activity':
      return handleSummarizeActivity(client, task.replyChannel, task.threadTs, task.queryChannel);
    case 'assistant_help':
      return handleAssistantHelp(client, task.replyChannel, task.threadTs);
    case 'approve':
      return handleApprove(client, store, task.feedbackId, task.userId);
    case 'reject':
      return handleReject(client, store, task.feedbackId, task.userId);
    case 'publish_home':
      return publishFinnHome(client, task.userId);
    case 'run_scenario':
      return handleRunScenario(client, store, task.scenarioId);
    case 'submit_feedback':
      return handleFeedbackSubmit(client, store, task.text, task.tier);
    default: {
      const _never: never = task;
      throw new Error(`Unhandled work task: ${JSON.stringify(_never)}`);
    }
  }
}
