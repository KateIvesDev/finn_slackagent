import type { KnownBlock } from "@slack/web-api";
import type { Verdict, SharkRole } from "./types.js";
import { STANCE_LABEL } from "./emoji.js";

// Finn's verdict card. Bounded autonomy: the rationale is always visible and nothing
// hits Jira/Zendesk until a human approves. The per-shark read mirrors the resolved
// emoji reactions, so the card confirms the story the reactions already told.

const SHARK_LABEL: Record<SharkRole, string> = {
  support: ":sos: Support",
  engineering: ":hammer_and_wrench: Engineering",
  product: ":compass: Product",
};

const ACTION_BADGE: Record<Verdict["action"]["type"], string> = {
  create_jira: ":large_blue_circle: Create Jira issue",
  create_zendesk: ":ticket: Create Zendesk ticket",
  dedup_link: ":link: Link to existing issue",
  roadmap_reply: ":world_map: Roadmap reply",
  no_action: ":no_entry_sign: No action",
};

// Action IDs your Bolt app listens for. Keep these stable; the approve handler routes
// the verdict.action.payload through the MCP layer (Vaultdesk for Zendesk).
export const APPROVE_ACTION_ID = "finn_verdict_approve";
export const REJECT_ACTION_ID = "finn_verdict_reject";

/**
 * Build the verdict message blocks. Post these as Finn *after* the reactions resolve.
 * Pass the verdict's own id/serialized payload as the button `value` so the handler
 * knows which verdict it's acting on.
 */
export function buildVerdictCard(verdict: Verdict, verdictValue: string): KnownBlock[] {
  const readLines = (Object.keys(verdict.reads) as SharkRole[])
    .map((role) => `${SHARK_LABEL[role]} — ${STANCE_LABEL[verdict.reads[role]]}`)
    .join("\n");

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Finn's call: ${verdict.headline}`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: verdict.rationale },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*The read*\n${readLines}` },
    },
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Proposed action:* ${ACTION_BADGE[verdict.action.type]} — ${verdict.action.label}`,
        },
      ],
    },
    // No buttons when there's nothing to approve — keeps the "no action" case honest.
    ...(verdict.action.type === "no_action"
      ? []
      : ([
          {
            type: "actions",
            elements: [
              {
                type: "button",
                style: "primary",
                text: { type: "plain_text", text: "Approve", emoji: true },
                action_id: APPROVE_ACTION_ID,
                value: verdictValue,
              },
              {
                type: "button",
                style: "danger",
                text: { type: "plain_text", text: "Reject", emoji: true },
                action_id: REJECT_ACTION_ID,
                value: verdictValue,
              },
            ],
          },
        ] as KnownBlock[])),
  ];
}

/**
 * Swap the buttons for a resolved footer after a PM clicks. Call from the approve/reject
 * handler with `chat.update` on the verdict message so the thread records the decision.
 */
export function buildResolvedFooter(
  verdict: Verdict,
  decision: "approved" | "rejected",
  userId: string,
): KnownBlock[] {
  const base = buildVerdictCard(verdict, "").filter((b) => b.type !== "actions");
  const note =
    decision === "approved"
      ? `:white_check_mark: Approved by <@${userId}> — ${verdict.action.label} routed through the action layer.`
      : `:x: Overruled by <@${userId}> — no action taken.`;
  return [...base, { type: "context", elements: [{ type: "mrkdwn", text: note }] }];
}