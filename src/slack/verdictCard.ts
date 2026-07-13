import type { KnownBlock } from "@slack/web-api";
import type { Verdict, SharkRole, Stance } from "./types.js";
import { STANCE_LABEL } from "./emoji.js";

/**
 * Routing policy — the core of Finn's "oversight layer" framing. The panel's
 * (dis)agreement is the signal for whether a HUMAN is needed:
 *   - 'auto'  : the three sharks agreed (no argument was overruled/unresolved)
 *               AND the action is low-stakes (no external write). Finn handles
 *               and logs it without interrupting anyone.
 *   - 'human' : any dissent, OR a consequential action (creating/linking a
 *               ticket, escalating). Route to a human with Approve/Reject.
 * The debate's demonstrable job is deciding WHICH — not deciding "better".
 */
export function routeVerdict(verdict: Verdict): "auto" | "human" {
  // no_action has nothing to execute — there is literally nothing for a human to
  // approve or reject — so it's ALWAYS auto-handled and logged, even when the
  // panel split on whether to act (the dissent stays visible in the ledger).
  // Routing it to a human produced the incoherent "@owner, action needed" ping
  // on a verdict whose card has no buttons.
  if (verdict.action.type === "no_action") return "auto";
  const consensus = (Object.values(verdict.reads) as Stance[]).every((s) => s === "favored");
  const lowStakes = verdict.action.type === "roadmap_reply";
  return consensus && lowStakes ? "auto" : "human";
}

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
    // Only rendered when the Judge actually named a tradeoff — most cases
    // resolve cleanly and this stays empty, which is the honest default.
    ...(verdict.tension
      ? ([
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `⚖️ *Where they disagreed:* ${verdict.tension}` }],
          },
        ] as KnownBlock[])
      : []),
    ...(verdict.decidingFactor
      ? ([
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Deciding factor:* ${verdict.decidingFactor}` },
          },
        ] as KnownBlock[])
      : []),
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
  decision: "approved" | "rejected" | "auto",
  userId?: string,
): KnownBlock[] {
  const base = buildVerdictCard(verdict, "").filter((b) => b.type !== "actions");
  const note =
    decision === "approved"
      ? `:white_check_mark: Approved by <@${userId}> — ${verdict.action.label} routed through the action layer.`
      : decision === "rejected"
        ? `:x: Overruled by <@${userId}> — no action taken.`
        : `:finn: *Handled autonomously* — the panel agreed on a low-stakes call, so Finn logged it without pulling in a human. ${verdict.action.label}.`;
  return [...base, { type: "context", elements: [{ type: "mrkdwn", text: note }] }];
}