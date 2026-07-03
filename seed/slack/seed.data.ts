// The seed *content* — edit stories here, not the plumbing in seed.ts.
//
// Everything below is the durable "context substrate": the institutional memory the
// sharks read via RTS. It is seeded once and left alone. The live debate stage
// (#feedback-firehose) is NOT seeded here — Finn and the sharks generate that at runtime,
// and reset.ts --stage clears it between demo runs.

/** Voices in the seeded threads. Rendered via chat:write.customize so threads read like
 *  real people instead of one bot talking to itself. */
export const PERSONAS = {
  priya: { username: "Priya · Support", icon: ":sos:" },
  marco: { username: "Marco · Engineering", icon: ":hammer_and_wrench:" },
  dana: { username: "Dana · Product", icon: ":compass:" },
  tom: { username: "Tom · Customer Success", icon: ":handshake:" },
  sam: { username: "Sam · Eng", icon: ":computer:" },
  lena: { username: "Lena · Ops", icon: ":gear:" },
} as const;

export type PersonaKey = keyof typeof PERSONAS;

export interface SeedReply {
  persona: PersonaKey;
  text: string;
}

export interface SeedThread {
  /** Channel name (no #). Created if missing. */
  channel: string;
  /** Scenario id this thread supports, or "distractor". Purely for your own auditing. */
  tag: string;
  persona: PersonaKey;
  text: string;
  replies?: SeedReply[];
}

/**
 * Vocabulary note: the same lag is phrased differently across threads ("sync lag",
 * "availability not updating", "stale calendar") so a shark's OR-query hits all of them.
 * Product is Cal.com throughout. Account names / issue numbers are consistent so
 * cross-references with Zendesk/Jira line up.
 */
export const THREADS: SeedThread[] = [
  // ── Scenario 1 · bug spike → new Jira issue ────────────────────────────────
  // A fresh cluster. The Eng shark should read "this is spiking now, file it."
  // NOTE: these post with a "now" timestamp — re-run just this tag before a demo
  // (seed.ts --only bug_spike) if you need them to read as today's spike.
  {
    channel: "incidents",
    tag: "bug_spike",
    persona: "marco",
    text: "Jump in reports of calendar availability not updating after a booking — 3 in the last hour across different orgs. Anyone else seeing this?",
    replies: [
      { persona: "sam", text: "Confirmed, repro on staging. Book a slot, refresh — old availability sticks for ~90s." },
      { persona: "marco", text: "Sync worker looks like it's lagging behind the booking events. Not a known one, no matching issue open." },
    ],
  },
  {
    channel: "support-escalations",
    tag: "bug_spike",
    persona: "priya",
    text: "Three tickets in the last hour, all the same shape: 'booked a meeting, my calendar still shows the slot as free.' Sending them your way #incidents.",
  },

  // ── Scenario 2 · known issue → dedup link, no new ticket ────────────────────
  // The Eng shark should find GH-4821 and say "we already track this."
  {
    channel: "eng-triage",
    tag: "known_issue",
    persona: "marco",
    text: "Reminder for triage: GH-4821 — calendar sync polling interval is capped at 5 min, so busy accounts perceive stale availability. Known limitation, already tracked.",
    replies: [
      { persona: "sam", text: "Right, this is by design until we move to webhook-based sync. Please dedup new reports into 4821 rather than opening fresh issues." },
    ],
  },

  // ── Scenario 3 · feature request → roadmap reply, no ticket ─────────────────
  // Product & Eng agree it's roadmap; Support advocates then concedes.
  {
    channel: "product-roadmap",
    tag: "feature_request",
    persona: "dana",
    text: "Q3 roadmap confirmed: real-time two-way calendar sync is slated (replaces the 5-min polling model). Spec is in the roadmap canvas.",
    replies: [
      { persona: "marco", text: "Good — that's the proper fix for the staleness complaints. No point in point-fixes before it lands." },
    ],
  },
  {
    channel: "product-decisions",
    tag: "feature_request",
    persona: "dana",
    text: "Decision: we are NOT shipping per-user sync-interval overrides. Superseded by the Q3 two-way sync work. Route requests to the roadmap thread.",
  },

  // ── Scenario 4 · ARR-weighted judgment call → verdict flips on tier ─────────
  // Same complaint. Enterprise-near-renewal context makes it act; free-tier doesn't.
  {
    channel: "renewals",
    tag: "arr_flip",
    persona: "tom",
    text: ":warning: Northwind Traders — $180k ARR, renewal Aug 31. Exec sponsor raised calendar sync lag on our last QBR and called it a dealbreaker. Flagging as churn risk.",
    replies: [
      { persona: "tom", text: "If this specific complaint resurfaces from Northwind, it needs to jump the queue — renewal is close and sentiment is already shaky." },
    ],
  },
  {
    channel: "voice-of-customer",
    tag: "arr_flip",
    persona: "priya",
    text: "Free-plan user grumbling that calendar sync is slow to refresh. Low heat, no account attached, just logging it for the pile.",
  },

  // ── Distractors · make "found N relevant out of many" credible ──────────────
  {
    channel: "incidents",
    tag: "distractor",
    persona: "sam",
    text: "Brief blip in email notification delivery earlier, resolved itself. Provider-side. No action.",
  },
  {
    channel: "eng-triage",
    tag: "distractor",
    persona: "marco",
    text: "GH-4790: timezone label shows abbreviation instead of full name on the booking page. Cosmetic, low priority.",
  },
  {
    channel: "product-roadmap",
    tag: "distractor",
    persona: "dana",
    text: "Reminder: routing rules revamp is the headline Q4 item, not Q3. Please stop promising it to customers for this quarter.",
  },
  {
    channel: "support-escalations",
    tag: "distractor",
    persona: "priya",
    text: "Customer asking whether we support SAML SSO on the Team plan — that's a sales question, redirecting.",
  },
  {
    channel: "voice-of-customer",
    tag: "distractor",
    persona: "lena",
    text: "Someone loves the new booking-page themes. Nice to see. Nothing to action.",
  },
  {
    channel: "renewals",
    tag: "distractor",
    persona: "tom",
    text: "Contoso renewed early, no issues raised. Great call from the CS team on that one.",
  },
  {
    channel: "incidents",
    tag: "distractor",
    persona: "lena",
    text: "Scheduled DB maintenance window Saturday 02:00–02:30 UTC. Expect brief read-only period.",
  },
];

/** Every channel referenced above — used by seed.ts to ensure they exist and are joined. */
export const SEEDED_CHANNELS = [...new Set(THREADS.map((t) => t.channel))];