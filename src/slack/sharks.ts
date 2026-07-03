import type { WebClient, KnownBlock } from "@slack/web-api";
import type { SharkRole } from "./types.js";

// The three panelists. They are NOT separate Slack users — they're chat:write.customize
// nameplates on the same app whose native identity is Finn. They share a visual family
// (role-emoji avatars, a "· Shark" suffix) so the eye groups them as a panel, and each
// is distinct from the others by role. None of them ever reacts — only Finn does.
//
// Set iconUrl to real hosted avatars for the strongest "distinct teammates" read on
// camera; fall back to iconEmoji otherwise.

export interface SharkIdentity {
  /** Nameplate shown as the sender. */
  name: string;
  /** Small emoji used as the in-message role anchor. */
  anchor: string;
  /** Avatar emoji, used when iconUrl is not set. */
  iconEmoji: string;
  /** Preferred: a hosted avatar image for a real teammate look. */
  iconUrl?: string;
}

export const SHARKS: Record<SharkRole, SharkIdentity> = {
  support: { name: "Support · Shark", anchor: ":sos:", iconEmoji: ":sos:" },
  engineering: { name: "Engineering · Shark", anchor: ":hammer_and_wrench:", iconEmoji: ":hammer_and_wrench:" },
  product: { name: "Product · Shark", anchor: ":compass:", iconEmoji: ":compass:" },
};

export interface SharkArgument {
  /** One-line stance. Keep it to a sentence — the panel should scan, not read. */
  claim: string;
  /** Up to ~2 evidence items. mrkdwn links welcome: "<url|label>". */
  evidence?: string[];
  /** Honest-advocate concession. Renders a subtle marker so agreement reads visibly. */
  conceded?: boolean;
}

/**
 * Build a shark's argument as deliberately-light blocks: a context role label, the claim,
 * and an optional evidence line. No header, no buttons — that restraint is what makes
 * Finn's card look like the host's verdict by contrast. Don't add either here.
 */
export function buildSharkMessage(role: SharkRole, arg: SharkArgument): KnownBlock[] {
  const { anchor, name } = SHARKS[role];
  const label = `${anchor} *${name}*${arg.conceded ? "  ·  _conceding_" : ""}`;

  const blocks: KnownBlock[] = [
    { type: "context", elements: [{ type: "mrkdwn", text: label }] },
    { type: "section", text: { type: "mrkdwn", text: arg.claim } },
  ];

  if (arg.evidence?.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: arg.evidence.slice(0, 2).join("  ·  ") }],
    });
  }
  return blocks;
}

/**
 * Post a shark's argument into the thread as its customized nameplate. Returns the ts so
 * Finn can drop 🤔 on it (see reactions.ts) and later resolve it.
 */
export async function postShark(
  client: WebClient,
  channel: string,
  role: SharkRole,
  arg: SharkArgument,
  threadTs?: string,
): Promise<string> {
  const id = SHARKS[role];
  const res = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `${id.name}: ${arg.claim}`, // notification fallback
    blocks: buildSharkMessage(role, arg),
    username: id.name,
    ...(id.iconUrl ? { icon_url: id.iconUrl } : { icon_emoji: id.iconEmoji }),
  });
  return res.ts as string;
}