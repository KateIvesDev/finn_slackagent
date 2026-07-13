import type { WebClient, KnownBlock, View } from "@slack/web-api";
import type { Scenario } from "./types.js";

// The judge-triggerable surface. Four scenario buttons guarantee judges see the verdict
// range in one click; the "Submit your own" modal — with an org-tier dropdown — lets them
// reproduce the ARR verdict flip themselves (same complaint, toggle tier, verdict changes).

// Action IDs / callbacks your Bolt app listens for.
export const RUN_SCENARIO_ACTION_ID = "finn_run_scenario"; // button value = scenario.id
export const OPEN_FEEDBACK_ACTION_ID = "finn_open_feedback";
export const FEEDBACK_MODAL_CALLBACK_ID = "finn_feedback_submit";

// Block IDs to read out of the submitted modal's state.values.
export const FEEDBACK_TEXT_BLOCK = "finn_feedback_text";
export const FEEDBACK_TEXT_ACTION = "value";
export const ORG_TIER_BLOCK = "finn_org_tier";
export const ORG_TIER_ACTION = "value";

/** Publish Finn's App Home tab for a user. Call on the `app_home_opened` event. */
export async function publishHome(
  client: WebClient,
  userId: string,
  scenarios: Scenario[], // <-- WIRE: pass your four canned scenarios from scenarios.ts
): Promise<void> {
  const scenarioBlocks: KnownBlock[] = scenarios.flatMap((s) => [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${s.title}*\n${s.blurb}` },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Run it", emoji: true },
        action_id: RUN_SCENARIO_ACTION_ID,
        value: s.id,
      },
    },
    { type: "divider" },
  ]);

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Meet Finn", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "Drop product feedback in the channel and the sharks debate it. Finn follows " +
          "along, forms a read, and posts a verdict you can approve or reject.\n\n" +
          "*Try a canned scenario, or submit your own below.*",
      },
    },
    { type: "divider" },
    ...scenarioBlocks,
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Submit your own feedback", emoji: true },
          action_id: OPEN_FEEDBACK_ACTION_ID,
        },
      ],
    },
  ];

  await client.views.publish({ user_id: userId, view: { type: "home", blocks } });
}

/** The feedback modal. Open on the OPEN_FEEDBACK_ACTION_ID button via views.open. */
export function feedbackModal(): View {
  return {
    type: "modal",
    callback_id: FEEDBACK_MODAL_CALLBACK_ID,
    title: { type: "plain_text", text: "Send Finn feedback" },
    submit: { type: "plain_text", text: "Send to the panel" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: FEEDBACK_TEXT_BLOCK,
        label: { type: "plain_text", text: "What's the feedback?" },
        element: {
          type: "plain_text_input",
          action_id: FEEDBACK_TEXT_ACTION,
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "e.g. Calendar sync lags by several minutes for busy accounts",
          },
        },
      },
      {
        type: "input",
        block_id: ORG_TIER_BLOCK,
        label: { type: "plain_text", text: "Reporter's account tier" },
        // The clever bit: toggling this flips the ARR-weighted verdict on the same complaint.
        element: {
          type: "static_select",
          action_id: ORG_TIER_ACTION,
          initial_option: tierOption("enterprise", "Enterprise (near renewal)"),
          options: [
            tierOption("free", "Free"),
            tierOption("enterprise", "Enterprise (near renewal)"),
          ],
        },
      },
    ],
  };
}

function tierOption(value: string, text: string) {
  return { text: { type: "plain_text" as const, text }, value };
}