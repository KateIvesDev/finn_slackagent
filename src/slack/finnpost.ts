import type { WebClient } from "@slack/web-api";
import type { Verdict } from "./types.js";
import { buildVerdictCard } from "./verdictCard.js";

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
            text: ":ocean: *Finn* — pulling in Support, Engineering, and Product. I'll weigh in as they go.",
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
 */
export async function postFinnVerdict(
  client: WebClient,
  channel: string,
  threadTs: string,
  verdict: Verdict,
  verdictValue: string,
): Promise<string> {
  // Primary `blocks`, not `attachments` — Slack collapses attachments behind
  // a "Show more" link past a few blocks, which was hiding the Approve/Reject
  // buttons. Costs the colored accent stripe (attachments-only), but the
  // buttons being visible without a click matters more than the color bar.
  const res = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `Finn's call: ${verdict.headline}`, // notification fallback
    blocks: buildVerdictCard(verdict, verdictValue),
  });
  return res.ts as string;
}