// The seed *content* — edit stories here, not the plumbing in seed.ts.
//
// Everything below is the durable "context substrate": the institutional memory the
// sharks read via RTS. It is seeded once and left alone. The live debate stage
// (#feedback-firehose) is NOT seeded here — Finn and the sharks generate that at runtime,
// and reset.ts --stage clears it between demo runs.

/** Voices in the seeded threads. Rendered via chat:write.customize so threads read like
 *  real people instead of one bot talking to itself. */
export const PERSONAS = {
  priya: { username: "Priya [Support]", icon_url: "https://api.dicebear.com/10.x/dylan/png?seed=74n2tb8a" },
  marco: { username: "Marco [Eng]", icon_url: "https://api.dicebear.com/10.x/dylan/png?seed=ynaqz34o" },
  dana: { username: "Dana [Product]", icon_url: "https://api.dicebear.com/10.x/dylan/png?seed=vgd1jtnk" },
  tom: { username: "Tom [Customer Success]", icon_url: "https://api.dicebear.com/10.x/dylan/png?seed=cu99fl3c" },
  sam: { username: "Sam [Eng]", icon_url: "https://api.dicebear.com/10.x/dylan/png?seed=sltgl7p9" },
  lena: { username: "Lena [Ops]", icon_url: "https://api.dicebear.com/10.x/dylan/png?seed=s5j2yk7s" },
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
 * Product is Kalabook throughout. Account names / issue numbers are consistent so
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
    text: "Decision (Dana): we're not building per-user sync-interval overrides — it's a band-aid, and once real-time two-way sync (KALA-1495) lands this quarter it's moot. Please route these requests to the roadmap thread rather than filing them.",
  },

  // ── Scenario 4 · ARR-weighted judgment call → verdict flips on tier ─────────
  // Same complaint. Enterprise-near-renewal context makes it act; free-tier doesn't.
  {
    channel: "renewals",
    tag: "arr_flip",
    persona: "tom",
    // Pinned to Ajax + EMBED (arr-judgment's actual topic), NOT Northwind + sync
    // lag. The old version tied Northwind's churn risk to "calendar sync lag",
    // which slackRtsSearch then surfaced on the sync-override scenario and
    // wrongly flipped it into a churn escalation. Keeping the at-risk renewal
    // signal on the embed topic corroborates arr-judgment and keeps it off the
    // sync-lag topic. (See the ZENDESK_CATALOG id 141 note in src/tools/index.ts.)
    text: ":warning: Ajax Corp — flag from the QBR: their exec sponsor singled out the embed on their marketing site (slow to load, layout shifting) and tied it directly to the renewal decision. CS is treating it as a churn risk. (Account facts / renewal date are in Zendesk.)",
    replies: [
      { persona: "tom", text: "If this embed complaint resurfaces from Ajax, it needs to jump the queue — sentiment there is already shaky heading into the renewal." },
    ],
  },
  {
    channel: "voice-of-customer",
    tag: "arr_flip",
    persona: "priya",
    text: "Free-plan user grumbling that calendar sync is slow to refresh. Low heat, no account attached, just logging it for the pile.",
  },

  // ── Public GitHub issues (kalabook/kalabook) · context substrate for RTS ──────
  // Engineering's slackRtsSearch can surface these directly — no live GitHub call
  // needed. General-realism substrate (fictional-but-plausible public issues) so a
  // shark searching e.g. "no available users", "login EU", or "reject button"
  // finds something, not empty results — not tied to any specific scenario.
  {
    channel: "github-issues",
    tag: "github_issue_log",
    persona: "marco",
    text: "GH-23391 — \"No available users found\" booking failure on open slots. Open since Aug '25, High priority + foundation labels, 36 comments and counting, no confirmed root cause. Route new reports here, don't open dupes. https://github.com/kalabook/kalabook/issues/23391",
    replies: [
      { persona: "sam", text: "Been trying to repro consistently — leaning toward a race in the availability cache, but it's intermittent. Still open." },
    ],
  },
  {
    channel: "github-issues",
    tag: "github_issue_log",
    persona: "marco",
    text: "GH-29720 — Google Calendar-side deletes weren't cancelling the Kalabook booking (one-way sync gap). Filed and fixed within 2 days, merged and closed. https://github.com/kalabook/kalabook/issues/29720",
    replies: [
      { persona: "marco", text: "Nice fast turnaround on this one. If it resurfaces post-fix, reopen rather than filing new." },
    ],
  },
  {
    channel: "github-issues",
    tag: "github_issue_log",
    persona: "marco",
    text: "GH-28201 — some EU-region accounts can't log in to the app. 16 comments, still open, looks auth/region-routing related. Worth a look if support volume picks up. https://github.com/kalabook/kalabook/issues/28201",
  },
  {
    channel: "github-issues",
    tag: "github_issue_log",
    persona: "sam",
    text: "GH-10827 — the Reject button in booking-decision emails cancels the booking with no confirmation popup, easy to fire by accident. Still open, small UX fix. https://github.com/kalabook/kalabook/issues/10827",
  },
  {
    channel: "github-issues",
    tag: "github_issue_log",
    persona: "sam",
    text: "GH-28506 — v6.2 regression: Google Meet option was showing the Kalabook video link instead of the actual Meet link. Closed/fixed. https://github.com/kalabook/kalabook/issues/28506",
  },
  {
    channel: "github-issues",
    tag: "github_issue_log",
    persona: "marco",
    text: "GH-28987 — duplicate events created when booking via CalDav (Fastmail tested). Closed/fixed. https://github.com/kalabook/kalabook/issues/28987",
  },
  {
    channel: "github-issues",
    tag: "github_issue_log",
    persona: "dana",
    text: "GH-23227 — \"Team members are now gated\" complaint, reads like a plan/paywall gripe more than a bug. 15 comments. Our call to make, not Eng's. https://github.com/kalabook/kalabook/issues/23227",
  },
  {
    channel: "github-issues",
    tag: "github_issue_log",
    persona: "marco",
    text: "GH-29628 — add-on (priced booking field) charges get dropped for additional seats. Revenue-adjacent — flag to Support/Product if a paying account hits it. https://github.com/kalabook/kalabook/issues/29628",
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