import type { WebClient, KnownBlock } from "@slack/web-api";
import type { Verdict } from "./types.js";
import { buildVerdictCard, buildResolvedFooter } from "./verdictCard.js";

// Finn posts as the app's NATIVE identity — so his name and avatar come from the app's
// profile config, distinct from the three shark nameplates. The rule that keeps him
// visually separate is mechanical: shark posts pass username/icon; Finn posts never do.
// Set Finn's name + a distinct avatar in your app settings (Display Information), not here.

/**
 * Finn convenes the panel at the top of the thread. Understated on purpose — his weight
 * is the verdict card, not the opener. No username/icon: this renders as native Finn.
 */
export async function postFinnOpener(
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<string> {
  const res = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "Finn is convening the panel…",
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: ":finn: *Finn* — pulling in Support, Engineering, and Product. I'll weigh in as they go.",
          },
        ],
      },
    ],
  });
  return res.ts as string;
}

/**
 * Finn's verdict — the heavy card, wrapped in a colored attachment so it reads as the
 * host's ruling rather than a fourth panelist. Native identity (no username/icon).
 * Post this only after the reactions have resolved.
 *
 * The debate itself stays thread-only (no need to spam the channel with every
 * shark's argument), but the verdict is the one message that needs a human to
 * act on it — so it broadcasts to the channel feed and, when a product-owner
 * usergroup is configured, @-mentions it so approval doesn't depend on
 * someone already following this specific thread.
 */
/** Build the right Slack mention syntax from an id: user groups (subteams) start
 *  with `S` and mention as `<!subteam^ID>`; users start with `U`/`W` and mention
 *  as `<@ID>`. Lets SLACK_PRODUCT_OWNER_GROUP_ID hold either. */
function formatMention(id: string): string {
  return id.startsWith("S") ? `<!subteam^${id}>` : `<@${id}>`;
}

export async function postFinnVerdict(
  client: WebClient,
  channel: string,
  threadTs: string,
  verdict: Verdict,
  verdictValue: string,
  mentionId?: string,
): Promise<string> {
  // Accept either a user group (Sxxx — a paid-plan feature) or a single user
  // (Uxxx/Wxxx), so the demo isn't blocked on a free workspace having usergroups.
  const mention = mentionId ? `${formatMention(mentionId)} ` : "";
  const mentionBlock: KnownBlock[] = mentionId
    ? [{ type: "context", elements: [{ type: "mrkdwn", text: `${mention}— action needed` }] }]
    : [];

  // Primary `blocks`, not `attachments` — Slack collapses attachments behind
  // a "Show more" link past a few blocks, which was hiding the Approve/Reject
  // buttons. Costs the colored accent stripe (attachments-only), but the
  // buttons being visible without a click matters more than the color bar.
  const res = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    // Also surfaces this reply in the main channel feed, so the actionable
    // card reaches an approver who isn't already in the thread.
    reply_broadcast: true,
    text: `${mention}Finn's call: ${verdict.headline}`, // notification fallback
    blocks: [...mentionBlock, ...buildVerdictCard(verdict, verdictValue)],
  });
  return res.ts as string;
}

/**
 * Finn's AUTONOMOUS resolution — for the cases the panel agreed on and that
 * carry no external write. It broadcasts to the channel feed (like the verdict
 * card) so the decision is visible and auditable, NOT buried in the thread —
 * but the deliberate contrast with postFinnVerdict remains: no @-mention and no
 * Approve/Reject buttons, because the whole point is that it DIDN'T need a
 * human. "Scales human attention" is about who gets interrupted, not what's
 * shown: every call is visible; only contested ones ping someone.
 */
export async function postFinnAutoHandled(
  client: WebClient,
  channel: string,
  threadTs: string,
  verdict: Verdict,
): Promise<string> {
  const res = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    reply_broadcast: true,
    text: `Finn handled this autonomously: ${verdict.headline}`,
    blocks: buildResolvedFooter(verdict, "auto"),
  });
  return res.ts as string;
}