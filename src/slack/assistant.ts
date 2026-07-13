/**
 * Slack's native Agent-container/DM surface — wired against the CURRENT
 * "agent_view" messaging experience directly with plain Bolt listeners, not
 * the Bolt `Assistant` class.
 *
 * Why not the Assistant class: Slack shipped agent_view on 2026-06-30,
 * replacing the older assistant_view model. New apps are forced onto
 * agent_view with no way to pick the old one. Bolt's `Assistant` class
 * (`threadStarted`/`threadContextChanged`/`userMessage`) only wraps the OLD
 * assistant_view events (`assistant_thread_started`,
 * `assistant_thread_context_changed`) — confirmed by grepping the installed
 * @slack/bolt package for either term and finding zero hits. Under
 * agent_view those events never fire, so `Assistant` silently does nothing:
 * no suggested prompts, no agent registration. agent_view's actual model
 * (per docs.slack.dev/ai/agent-entry-and-interaction) is:
 *   - `app_home_opened` with `tab === 'messages'`  → analogue of "thread started"
 *   - `app_context_changed`                        → context/view changes
 *   - `message.im`                                  → the user's message
 *
 * The underlying Slack Web API calls (`client.assistant.threads.*`,
 * `client.chatStream`) are plain WebClient methods, not gated by the
 * Assistant class — so finnFlowStreamed.ts, which only ever used those,
 * needs no changes at all.
 */
import type bolt from '@slack/bolt';
import { loadConfig } from '../config/index.js';
import type { Feedback } from '../types/index.js';
import type { Dispatch } from './listeners.js';
import { scenarios as demoScenarios } from '../../seed/scenarios.js';

// Slack caps suggested prompts at four, and a distinct, differentiated
// capability (retrieval over Finn's own memory, not re-running the sharks)
// is worth a dedicated slot — so this trims to 3 demo scenarios rather than
// 4. All 4 scenarios are still one click away on the App Home tab.
const SUMMARY_PROMPT_TITLE = "What's been decided recently?";
const SUMMARY_PROMPT_MESSAGE = "What's been decided in this channel recently?";
const HELP_PROMPT_TITLE = "How does Finn work?";
const HELP_PROMPT_MESSAGE = "How does Finn work?";
// Fallback for anyone typing their own phrasing instead of clicking the
// suggested prompt — deliberately narrow so real feedback text describing an
// actual bug/request doesn't get misrouted into a summary instead of a debate.
const SUMMARY_INTENT = /\b(summar|recent|this week|last week|trend|what.*(happen|decided))\b/i;
// Greetings + "how do I use this" — short-circuit to an onboarding blurb so a
// judge opening the DM and typing "hi"/"help" doesn't spawn a debate over the
// word. Kept narrow (and the leading greetings anchored to the start) so real
// feedback like "how do I change my timezone" still routes to a debate.
const HELP_INTENT =
  /^(hi|hey|hello|help|thanks|thank you)\b|\b(what can you do|who are you|what are you|how (do|does)\s+(i|you|this|finn)\b.*\b(work|use|help|start)|get started|getting started)\b/i;

export function registerFinnAgent(app: bolt.App, dispatch: Dispatch): void {
  // agent_view's analogue of "thread started" — the first time a user opens
  // the Messages tab conversation with this app. No dedicated thread_ts
  // exists yet at this point (setSuggestedPrompts's thread_ts is optional
  // for exactly this reason), so this is channel-scoped, not thread-scoped.
  app.event('app_home_opened', async ({ event, client, logger }) => {
    if (event.tab !== 'messages') return;
    try {
      await client.assistant.threads.setSuggestedPrompts({
        channel_id: event.channel,
        title: 'Ask how Finn works, what\'s been decided, or paste real feedback',
        prompts: [
          { title: HELP_PROMPT_TITLE, message: HELP_PROMPT_MESSAGE },
          { title: SUMMARY_PROMPT_TITLE, message: SUMMARY_PROMPT_MESSAGE },
        ],
      });
    } catch (err) {
      logger.error(err);
    }
  });

  // Channel-aware prompt tuning is future work — not required for "agent,
  // not bot," so this is currently a no-op placeholder.
  app.event('app_context_changed', async () => {});

  // message.im — the Agent-container/DM conversation itself. Kept separate
  // from listeners.ts's feedback-channel listener, which already ignores
  // DMs (they never match SLACK_FEEDBACK_CHANNEL); this one only handles DMs.
  app.message(async ({ message, logger }) => {
    if (message.subtype || !('text' in message) || !message.text) return;
    if (!('channel_type' in message) || message.channel_type !== 'im') return;

    const channel = message.channel;
    const threadTs = 'thread_ts' in message && message.thread_ts ? message.thread_ts : message.ts;

    try {
      // Three capabilities on one surface, checked most-specific first:
      // onboarding (help/greeting) → retrieval over Finn's own memory (summarize)
      // → triggering a fresh debate (everything else, the default).
      if (HELP_INTENT.test(message.text)) {
        await dispatch({ type: 'assistant_help', replyChannel: channel, threadTs });
        return;
      }
      if (SUMMARY_INTENT.test(message.text)) {
        // Query the real feedback channel's ledger, not just this DM's —
        // asking "what's been decided" here shouldn't only surface debates
        // that happened to be triggered from this same conversation.
        const queryChannel = loadConfig().SLACK_FEEDBACK_CHANNEL || channel;
        await dispatch({ type: 'summarize_activity', replyChannel: channel, threadTs, queryChannel });
        return;
      }

      const feedback: Feedback = {
        id: message.ts,
        text: message.text,
        channel,
        threadTs,
        user: 'user' in message ? message.user : undefined,
      };
      await dispatch({ type: 'assistant_message', feedback });
    } catch (err) {
      logger.error(err);
    }
  });
}
