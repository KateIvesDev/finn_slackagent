/**
 * Registers Bolt listeners that translate Slack events into WorkTasks and
 * hand them to `dispatch`. This file is transport-agnostic: it doesn't know
 * or care whether `dispatch` runs the task inline (Socket Mode) or hands it
 * off to an async-invoked Lambda (src/lambda/receiver.ts) — see the WorkTask
 * doc comment in src/slack/types.ts.
 *
 * Every listener acks/returns fast; the actual multi-agent work happens
 * wherever `dispatch` sends it, never in this file.
 */
import type bolt from '@slack/bolt';
import { loadConfig } from '../config/index.js';
import type { Feedback } from '../types/index.js';
import type { WorkTask } from './types.js';
import { RUN_SCENARIO_ACTION_ID, OPEN_FEEDBACK_ACTION_ID, FEEDBACK_MODAL_CALLBACK_ID, FEEDBACK_TEXT_BLOCK, FEEDBACK_TEXT_ACTION, ORG_TIER_BLOCK, ORG_TIER_ACTION, feedbackModal } from './apphome.js';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID } from './verdictCard.js';

export type Dispatch = (task: WorkTask) => Promise<void>;

export function registerListeners(app: bolt.App, dispatch: Dispatch): void {
  const cfg = loadConfig();

  // 1. New feedback message → run the Finn flow.
  app.message(async ({ message, logger }) => {
    // Type-narrow: only handle plain user messages with text in our channel.
    // (Bot-posted messages carry a subtype, so this also skips Finn's/the
    // sharks' own posts — the "run scenario" / modal paths dispatch directly
    // instead of relying on this listener to re-detect them.)
    if (message.subtype || !('text' in message) || !message.text) return;
    if (cfg.SLACK_FEEDBACK_CHANNEL && message.channel !== cfg.SLACK_FEEDBACK_CHANNEL) {
      return;
    }

    const feedback: Feedback = {
      id: message.ts,
      text: message.text,
      channel: message.channel,
      threadTs: message.ts,
      user: 'user' in message ? message.user : undefined,
    };

    try {
      await dispatch({ type: 'run_finn_flow', feedback });
    } catch (err) {
      logger.error(err);
    }
  });

  // 2a. Approve button.
  app.action(APPROVE_ACTION_ID, async ({ ack, body, logger }) => {
    await ack(); // must ack within 3s
    try {
      const userId = (body as any).user?.id as string;
      const { feedbackId } = JSON.parse((body as any).actions[0].value);
      await dispatch({ type: 'approve', feedbackId, userId });
    } catch (err) {
      logger.error(err);
    }
  });

  // 2b. Reject button.
  app.action(REJECT_ACTION_ID, async ({ ack, body, logger }) => {
    await ack();
    try {
      const userId = (body as any).user?.id as string;
      const { feedbackId } = JSON.parse((body as any).actions[0].value);
      await dispatch({ type: 'reject', feedbackId, userId });
    } catch (err) {
      logger.error(err);
    }
  });

  // 3. App Home — judge-triggerable scenarios + "submit your own feedback".
  app.event('app_home_opened', async ({ event, logger }) => {
    try {
      await dispatch({ type: 'publish_home', userId: event.user });
    } catch (err) {
      logger.error(err);
    }
  });

  app.action(RUN_SCENARIO_ACTION_ID, async ({ ack, body, logger }) => {
    await ack();
    try {
      const scenarioId = (body as any).actions[0].value as string;
      await dispatch({ type: 'run_scenario', scenarioId });
    } catch (err) {
      logger.error(err);
    }
  });

  app.action(OPEN_FEEDBACK_ACTION_ID, async ({ ack, body, client, logger }) => {
    await ack();
    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: feedbackModal(),
      });
    } catch (err) {
      logger.error(err);
    }
  });

  app.view(FEEDBACK_MODAL_CALLBACK_ID, async ({ ack, view, logger }) => {
    await ack();
    try {
      const values = view.state.values;
      const text = values[FEEDBACK_TEXT_BLOCK]?.[FEEDBACK_TEXT_ACTION]?.value;
      const tier = values[ORG_TIER_BLOCK]?.[ORG_TIER_ACTION]?.selected_option?.value;
      if (!text) return;
      await dispatch({ type: 'submit_feedback', text, tier });
    } catch (err) {
      logger.error(err);
    }
  });
}
