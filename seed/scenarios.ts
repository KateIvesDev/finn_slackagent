/**
 * scenarios.ts
 *
 * Seed data for the feedback-debate demo, grounded in Kalabook (a fictional
 * scheduling product). Each scenario is engineered so that when the persona
 * agents go search Zendesk / Jira / Slack history — and look up account context
 * and the roadmap — the evidence they find FORCES a specific, legible verdict.
 * The scenarios resolve to different action paths, and half of them are genuine
 * value tradeoffs (not dedup checks) so the debate has real stakes:
 *
 *   1. bug-spike       -> create_jira    (consensus: cluster of tickets, nothing tracked)
 *   2. known-issue     -> dedup_link     (consensus: already tracked, don't duplicate)
 *   3. feature-request -> roadmap_reply  (mild: on the roadmap, reply with the ETA)
 *   4. arr-judgment    -> create_zendesk (FIGHT: same complaint, ARR tips the call)
 *   5. cheap-fix       -> no_action      (FIGHT: Eng "cheap, do it" vs Product opportunity cost)
 *   6. sync-override   -> roadmap_reply  (FIGHT: Support volume vs an explicit Product non-goal)
 *
 * Scenarios 4–6 are the ones that earn the "debate" framing: the personas land on
 * different recommendations for genuine value reasons (business stakes, opportunity
 * cost, strategic non-goals) and the Judge has to actually pick. 1–3 are the fast,
 * legible consensus cases that make the fights read as fights by contrast.
 *
 * The `expected` field is for YOUR reference (and later, eval assertions) — it is
 * never shown to the agents. The agents must reach these verdicts from evidence.
 */

// ---------------------------------------------------------------------------
// Types (mirror /src/types — kept here so the seed module is self-contained)
// ---------------------------------------------------------------------------

// Values mirror src/slack/types.ts's VerdictActionType — kept as its own literal
// union (not an import) so this module stays self-contained, but the strings
// must match: `expected.action` is compared against a real Verdict later.
export type VerdictAction =
  | 'create_jira'
  | 'dedup_link'
  | 'roadmap_reply'
  | 'create_zendesk'
  | 'no_action';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface SeedZendeskOrg {
  /** Stable id used for idempotent seeding (external_id in Zendesk). */
  externalId: string;
  name: string;
  /** Custom org field `plan`. */
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  /** Custom org field `arr_usd` — the Support agent reads this to weigh priority. */
  arrUsd?: number;
  /** Custom org field `renewal_date` (ISO). Renewal proximity drives the ARR flip. */
  renewalDate?: string;
  /** Custom org field `health`. */
  health?: 'healthy' | 'watch' | 'at-risk';
  /** Built-in Zendesk org `notes` — the one-line CSM/renewal signal Support quotes. */
  note?: string;
}

export interface SeedZendeskTicket {
  /** Stable id so re-running the seed updates rather than duplicates. */
  externalId: string;
  subject: string;
  description: string;
  requesterEmail: string;
  /** Ties the requester to an org (for ARR weighting). */
  orgExternalId?: string;
  tags?: string[];
  /**
   * How recent the ticket should look. NOTE: Zendesk's normal create API does
   * NOT honor created_at — it's only respected via the Ticket Import endpoint.
   * For the spike scenario, easiest path is to seed fresh right before you
   * record so everything is genuinely recent. This field documents intent and
   * is used by seed.ts only if you wire the import endpoint.
   */
  createdDaysAgo?: number;
}

export interface SeedJiraIssue {
  /** Reference key for wiring/links in this file. Real key is assigned by Jira. */
  externalKey: string;
  summary: string;
  description: string;
  issueType: 'Bug' | 'Story' | 'Epic';
  status: 'Backlog' | 'To Do' | 'In Progress' | 'Done';
  /** e.g. ['roadmap','q4'] — the Product agent keys off roadmap labels. */
  labels?: string[];
}

export interface SeedSlackMessage {
  /** Planted channel history so the RTS API has something to surface. */
  daysAgo: number;
  author: string;
  text: string;
}

export interface ExpectedVerdict {
  action: VerdictAction;
  priority?: Priority;
  /** When action is jira_link — which existing issue to link to. */
  linksToJira?: string;
  /** Human-readable "why", for your reference / eval assertions only. */
  rationale: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** The feedback item that lands in the Slack channel and kicks off the debate. */
  triggerFeedback: {
    text: string;
    sourceUser: string;
    /** Ties the incoming feedback to an org so ARR context is available. */
    orgExternalId?: string;
  };
  seedOrgs?: SeedZendeskOrg[];
  seedZendeskTickets?: SeedZendeskTicket[];
  seedJiraIssues?: SeedJiraIssue[];
  seedSlackHistory?: SeedSlackMessage[];
  expected: ExpectedVerdict;
}

// ---------------------------------------------------------------------------
// Shared orgs (referenced across scenarios)
// ---------------------------------------------------------------------------

// `satisfies` (not `: Record<string, SeedZendeskOrg>`) keeps the literal keys
// (ajax/brightpath/hobby) in the type, so `orgs.ajax` is `SeedZendeskOrg`, not
// `SeedZendeskOrg | undefined` — a plain Record<string,...> annotation widens
// to a string index signature, which noUncheckedIndexedAccess then flags.
// The full account book — mirrors the accountContext ACCOUNTS in
// src/tools/index.ts so real Zendesk org fields reproduce the tuned scenarios.
// Every org a ticket requester belongs to must be here (the seeder resolves a
// requester's org by email domain), which is why Northwind + Lumina appear even
// though no scenario lists them in `seedOrgs`.
export const orgs = {
  ajax: {
    externalId: 'org-ajax',
    name: 'Ajax Corp',
    plan: 'enterprise',
    arrUsd: 48000,
    // Set at seed time to ~2 weeks out; hardcoded here for reference.
    renewalDate: '2026-07-24',
    health: 'at-risk',
    note: 'Enterprise; renewal approaching; CS flagged health at-risk in the latest account review.',
  },
  northwind: {
    externalId: 'org-northwind',
    name: 'Northwind Traders',
    plan: 'enterprise',
    arrUsd: 180000,
    renewalDate: '2026-08-31',
    health: 'at-risk',
    note: 'Enterprise; large account; health at-risk — watch closely into the Aug renewal.',
  },
  brightpath: {
    externalId: 'org-brightpath',
    name: 'BrightPath Studio',
    plan: 'team',
    arrUsd: 6000,
    health: 'healthy',
    note: 'Team plan, healthy account, no renewal pressure.',
  },
  lumina: {
    externalId: 'org-lumina',
    name: 'Lumina',
    plan: 'pro',
    arrUsd: 3000,
    health: 'healthy',
    note: 'Pro plan, healthy account.',
  },
  meridian: {
    externalId: 'org-meridian',
    name: 'Meridian Wellness',
    plan: 'team',
    arrUsd: 9000,
    health: 'healthy',
    note: 'Team plan, healthy account; heavy recurring-scheduling user.',
  },
  hobby: {
    externalId: 'org-mayaellis',
    name: 'Maya Ellis Coaching',
    plan: 'free',
    arrUsd: 0,
    health: 'healthy',
    note: 'Free tier, no ARR or renewal at stake.',
  },
} satisfies Record<string, SeedZendeskOrg>;

/** Every org, for the seeder to upsert up front (tickets resolve their org by
 *  the requester's email domain, so all orgs must exist first). */
export const allOrgs: SeedZendeskOrg[] = Object.values(orgs);

/** Map an email domain to its org external_id, so a ticket's requester lands in
 *  the right org (and inherits its ARR/renewal/health custom fields). */
export const orgByEmailDomain: Record<string, string> = {
  'ajax.example': 'org-ajax',
  'northwind.example': 'org-northwind',
  'brightpath.example': 'org-brightpath',
  'lumina.example': 'org-lumina',
  'mayaellis.example': 'org-mayaellis',
  'meridian.example': 'org-meridian',
};

// ---------------------------------------------------------------------------
// Scenario 1 — BUG SPIKE -> jira_create
// A real defect hitting multiple customers in a tight window, with NOTHING
// tracked in Jira. The Support agent's search finds the cluster; the
// Engineering agent's search comes back empty. Verdict: file a Bug, high
// priority (revenue-impacting: teams are double-booking), link the tickets.
//
// The craft here is PHRASING VARIETY — five tickets describing one root cause
// in five different voices. Correctly clustering these is what looks smart.
// ---------------------------------------------------------------------------

export const bugSpike: Scenario = {
  id: 'bug-spike',
  title: 'Recurring bookings silently dropping from Google Calendar',
  triggerFeedback: {
    text:
      "New feedback from BrightPath Studio: 'Set up a weekly team sync as a recurring " +
      "event. The first one showed up on my Google Calendar but none of the repeats " +
      "did. Found out because two of us booked over the same slot. Kind of a big deal.'",
    sourceUser: 'widget@cal-feedback',
    orgExternalId: 'org-brightpath',
  },
  seedZendeskTickets: [
    {
      externalId: 'zd-spike-1',
      subject: 'Recurring meetings not syncing to Google Cal',
      description:
        "I create a recurring event type and only the very first occurrence lands " +
        "in Google Calendar. The rest are confirmed in Kalabook but invisible on my " +
        "calendar. Started sometime this week.",
      requesterEmail: 'dana@brightpath.example',
      orgExternalId: 'org-brightpath',
      tags: ['google-calendar', 'recurring'],
      createdDaysAgo: 2,
    },
    {
      externalId: 'zd-spike-2',
      subject: 'Half my bookings missing from calendar since Tuesday',
      description:
        "Something broke. Bookings say confirmed but a bunch never appear on my " +
        "Google Calendar. It's the repeating ones as far as I can tell. Was fine last week.",
      requesterEmail: 'marcus@northwind.example',
      tags: ['google-calendar'],
      createdDaysAgo: 2,
    },
    {
      externalId: 'zd-spike-3',
      subject: 'Weekly standup invites stopped appearing in Google Calendar',
      description:
        "Our whole team uses a recurring standup event type. The invites just stop " +
        "showing up on Google Calendar after the first week. We've had two double-bookings " +
        "already because people don't see the slot is taken.",
      requesterEmail: 'priya@brightpath.example',
      orgExternalId: 'org-brightpath',
      tags: ['recurring', 'double-booking'],
      createdDaysAgo: 1,
    },
    {
      externalId: 'zd-spike-4',
      subject: 'Google Calendar integration broken?',
      description:
        "Bookings confirmed in Kalabook but not on my Google Calendar. Disconnected and " +
        "reconnected the integration, no change. Only seems to be repeat events.",
      requesterEmail: 'sam@lumina.example',
      tags: ['google-calendar', 'integration'],
      createdDaysAgo: 1,
    },
    {
      externalId: 'zd-spike-5',
      subject: 'URGENT - team double booking because calendar sync is dropping events',
      description:
        "This is causing real problems. Recurring bookings are confirmed on Kalabook but " +
        "not written to Google Calendar, so my team keeps booking over each other. Please fix.",
      requesterEmail: 'jordan@northwind.example',
      tags: ['google-calendar', 'recurring', 'urgent'],
      createdDaysAgo: 0,
    },
  ],
  // Intentionally NO seedJiraIssues — the whole point is that nothing is tracked.
  expected: {
    action: 'create_jira',
    priority: 'high',
    rationale:
      'Five differently-worded tickets in <3 days describe one root cause (recurring ' +
      'occurrences not written to Google Calendar after the first). No matching Jira ' +
      'issue exists. Impact is revenue-adjacent (double-bookings across teams). Support ' +
      'argues urgency from the cluster + timing; Engineering confirms nothing is tracked. ' +
      'File a high-priority Bug and link all five tickets.',
  },
};

// ---------------------------------------------------------------------------
// Scenario 2 — KNOWN ISSUE -> jira_link  (the RTS dedup moment)
// The feedback matches a defect that's ALREADY an open Jira issue AND was
// already discussed in the channel last week. The Engineering agent's Jira
// search surfaces KALA-1487; the RTS search surfaces the prior Slack thread.
// Verdict: DO NOT create a duplicate — link this report to KALA-1487, add the
// customer as affected, comment. This is the highest-impact narrative:
// "did we already log this?" is the pain everyone recognizes.
// ---------------------------------------------------------------------------

export const knownIssue: Scenario = {
  id: 'known-issue',
  title: 'Outlook bookings showing at the wrong time (already tracked)',
  triggerFeedback: {
    text:
      "New feedback from BrightPath Studio: 'When my clients on Outlook book me, the meeting shows up an hour " +
      "off on their side. I'm in US Central. It's on the Kalabook confirmation correctly " +
      "but wrong in their Outlook invite.'",
    sourceUser: 'widget@cal-feedback',
    // Healthy account on purpose — this is the dedup-restraint scenario. Reporting
    // from at-risk Ajax would (correctly) trigger a CSM escalation via accountContext
    // and collapse this into the arr-judgment verdict. See the ZENDESK_CATALOG note
    // for id 110 in src/tools/index.ts.
    orgExternalId: 'org-brightpath',
  },
  seedJiraIssues: [
    {
      externalKey: 'KALA-1487',
      summary: 'Office 365 booking invites offset by 1 hour for non-UTC organizers',
      description:
        'Confirmed bug: for organizers in non-UTC timezones, the ICS/invite written to ' +
        'the invitee via the Office 365 integration is offset by one hour (DST boundary ' +
        'handling). Kalabook-side confirmation is correct; only the pushed invite is wrong. ' +
        'Repro on US Central and US Eastern.',
      issueType: 'Bug',
      status: 'In Progress',
      labels: ['office365', 'timezone'],
    },
  ],
  seedZendeskTickets: [
    {
      externalId: 'zd-known-1',
      subject: 'Outlook invite one hour off',
      description:
        "Clients booking me on Outlook get an invite thats an hour earlier than the " +
        "actual time. Kalabook shows the right time. Already reported I think but adding mine.",
      requesterEmail: 'lee@brightpath.example',
      orgExternalId: 'org-brightpath',
      tags: ['office365', 'timezone'],
      createdDaysAgo: 6,
    },
  ],
  seedSlackHistory: [
    {
      daysAgo: 7,
      author: 'Support (Renee)',
      text:
        "Heads up — we've had a couple of reports of Office 365 invites landing an hour " +
        "off for non-UTC folks. Eng opened KALA-1487, it's in progress. Route new ones there.",
    },
    {
      daysAgo: 5,
      author: 'Eng (Tobias)',
      text:
        "KALA-1487 update: root-caused to DST handling in the O365 invite writer. Fix in " +
        "review. If more customers hit it, add them to the ticket so we can gauge blast radius.",
    },
  ],
  expected: {
    action: 'dedup_link',
    linksToJira: 'KALA-1487',
    priority: 'normal',
    rationale:
      'The complaint matches an already-open, in-progress Jira bug (KALA-1487) AND the ' +
      'channel history explicitly says to route new reports there. Creating a new ticket ' +
      'would be a duplicate. Correct action: link this report to KALA-1487, add the customer ' +
      'as affected, and comment for blast-radius tracking. Demonstrates restraint + dedup.',
  },
};

// ---------------------------------------------------------------------------
// Scenario 3 — FEATURE REQUEST -> none  (roadmap deflect)
// Not a bug — an enhancement request. The Engineering agent classifies it as
// working-as-designed; the Product agent's search finds it's already on the
// roadmap (a Jira Epic labeled 'roadmap'). Verdict: no ticket — reply with the
// planned timeframe and log a +1. Proves the system knows when NOT to act,
// which is rare in these demos and reads as mature.
// ---------------------------------------------------------------------------

export const featureRequest: Scenario = {
  id: 'feature-request',
  title: 'Waitlist for fully-booked slots (already on the roadmap)',
  triggerFeedback: {
    text:
      "New feedback from Lumina: 'Love Kalabook. One thing — when a popular slot is full, people give " +
      "up. Could you add a waitlist so they get notified if it frees up? Would save us a " +
      "ton of back-and-forth.'",
    sourceUser: 'widget@cal-feedback',
    orgExternalId: 'org-lumina',
  },
  seedJiraIssues: [
    {
      externalKey: 'KALA-1102',
      summary: '[Roadmap] Waitlist with auto-promotion for event types',
      description:
        'Planned enhancement: allow invitees to join a waitlist for fully-booked event ' +
        'types and auto-notify/promote them when a slot frees up. Scoped, targeted for a ' +
        'future release. Multiple inbound requests already logged against this.',
      issueType: 'Epic',
      status: 'To Do',
      labels: ['roadmap', 'q4', 'feature-request'],
    },
  ],
  expected: {
    // Not 'no_action' — this resolves with a customer-facing roadmap reply,
    // which the verdict card renders as its own distinct action badge.
    action: 'roadmap_reply',
    rationale:
      'This is an enhancement, not a defect. Engineering flags it as working-as-designed; ' +
      'Product finds it already scoped on the roadmap (KALA-1102, labeled roadmap/q4). ' +
      'Creating a new ticket would be noise. Correct action: post a friendly reply naming ' +
      'the planned timeframe and increment the +1 count on KALA-1102. No ticket created.',
  },
};

// ---------------------------------------------------------------------------
// Scenario 4 — ARR JUDGMENT -> zendesk_create  (the debate that matters)
// The SAME complaint (embed widget perf) resolves differently depending on WHO
// is asking. From a free user it's backlog. From Ajax (enterprise, $48k ARR,
// renewal in ~3 weeks) it's an escalation. The Support agent pulls the org's
// plan/ARR/renewal; Engineering argues low-effort-low-value; Product says it's
// off the core roadmap. The Judge weighs the $ and renewal risk and escalates.
// This is the scenario that proves the debate isn't theater.
//
// Tip for the demo: run this feedback once as Ajax, then once as the free org
// (swap triggerFeedback.orgExternalId to 'org-hobby') to show the SAME input
// producing a DIFFERENT verdict. That side-by-side is the money shot.
// ---------------------------------------------------------------------------

export const arrJudgment: Scenario = {
  id: 'arr-judgment',
  title: 'Embed widget slow / layout shift — priority depends on the account',
  triggerFeedback: {
    text:
      "New feedback from Ajax Corp: 'Your embed is janky on our marketing site — it loads " +
      "slowly and shoves the page around as it renders (layout shift). It's hurting our " +
      "conversion and honestly it's a bad look on our homepage.'",
    sourceUser: 'success@ajax.example',
    orgExternalId: 'org-ajax',
  },
  seedOrgs: [orgs.ajax, orgs.hobby],
  seedZendeskTickets: [
    {
      externalId: 'zd-arr-1',
      subject: 'Embed causes layout shift on our site',
      description:
        "The inline embed pushes our page content around as it loads and is slow on " +
        "mobile. On our homepage above the fold. Needs to be smoother.",
      requesterEmail: 'success@ajax.example',
      orgExternalId: 'org-ajax',
      tags: ['embed', 'performance'],
      createdDaysAgo: 1,
    },
  ],
  seedJiraIssues: [
    {
      externalKey: 'KALA-980',
      summary: 'Embed: reduce layout shift (CLS) and improve first-load performance',
      description:
        'Known long-tail perf item for the inline embed. Reserve space to avoid CLS, defer ' +
        'non-critical work. Low individual severity, broad but diffuse impact. Backlog.',
      issueType: 'Story',
      status: 'Backlog',
      labels: ['embed', 'performance', 'backlog'],
    },
  ],
  expected: {
    action: 'create_zendesk',
    priority: 'high',
    rationale:
      'Engineering correctly reads this as low-severity, already-backlogged perf work ' +
      '(KALA-980) — from a free user, the right call is "backlog, no action." But the Support ' +
      'agent surfaces that the reporter is Ajax: enterprise, $48k ARR, renewal ~2 weeks out, ' +
      'health at-risk (Zendesk) — and #renewals shows the exec tied the embed to the renewal ' +
      'at the QBR (Slack). Note the customer feedback itself does NOT mention the renewal; ' +
      'Support has to connect the account facts to the internal churn signal. The Judge weighs ' +
      'churn risk ' +
      'over engineering-effort math and escalates: create a high-priority Zendesk ticket ' +
      'routed to the account/CSM, and link (not re-create) KALA-980 for the eng side. The ' +
      'ARR context flips the verdict — that is the debate earning its keep.',
  },
};

// ---------------------------------------------------------------------------
// Scenario 5 — CHEAP FIX, OFF-THEME -> no_action  (the mirror of the ARR call)
// A tiny, genuinely-cheap UI polish from a free-tier user, nothing tracked.
// Engineering reads it as a trivial ~1-hour fix and leans "sure, just file it."
// Product argues the opposite: it's real but cosmetic, off the committed Q3
// theme, and one dev-hour here is a dev-hour off two-way sync — with no volume
// or account value to justify jumping the queue. The Judge sides with Product:
// cheapness is not the same as worth. This is the deliberate counterpart to the
// ARR scenario — there, low severity gets escalated because of business stakes;
// here, a low-cost fix is declined because of opportunity cost. Same "low
// signal" input, opposite verdicts, both decided on a real axis.
// ---------------------------------------------------------------------------

export const cheapFixOffTheme: Scenario = {
  id: 'cheap-fix',
  title: '"Add to calendar" button hard to find on mobile (cheap, but off-theme)',
  triggerFeedback: {
    text:
      "New feedback from Maya Ellis Coaching: 'The \"Add to calendar\" link on the booking " +
      "confirmation screen is tiny and greyed out — on my phone I almost missed it. " +
      "Could it be a proper button?'",
    sourceUser: 'widget@cal-feedback',
    orgExternalId: 'org-hobby',
  },
  seedOrgs: [orgs.hobby],
  seedZendeskTickets: [
    {
      externalId: 'zd-cheap-1',
      subject: 'Add to calendar link easy to miss',
      description:
        "Minor thing — the add-to-calendar link after booking is small and low-contrast. " +
        "Took me a second to spot it on mobile. Would be nicer as a button.",
      requesterEmail: 'maya@mayaellis.example',
      orgExternalId: 'org-mayaellis',
      tags: ['ui', 'mobile'],
      createdDaysAgo: 9,
    },
  ],
  // Intentionally NO seedJiraIssues — it's untracked, so this is NOT a dedup.
  // The debate is purely about whether a cheap, low-signal fix is worth doing.
  expected: {
    action: 'no_action',
    rationale:
      'A real but cosmetic UI polish from a single free-tier reporter, nothing tracked. ' +
      'Engineering reads it as a trivial ~1-hour fix and leans toward just filing it; ' +
      'Product argues opportunity cost — it is off the committed Q3 theme (two-way sync), ' +
      'there is no volume and no account value, and a dev-hour spent here is a dev-hour not ' +
      'spent on the quarter. The Judge weights opportunity cost over cheapness: no ticket ' +
      'now, backlog it. The deliberate mirror of the ARR scenario — low signal, declined on ' +
      'strategy rather than escalated on stakes.',
  },
};

// ---------------------------------------------------------------------------
// Scenario 6 — OFF-STRATEGY DEMAND -> roadmap_reply  (Support volume vs an
// explicit Product non-goal). Real, recurring pain (stale availability) but the
// SPECIFIC ask — a user-configurable sync interval — is something the team has
// explicitly decided NOT to build, because the proper fix (real-time two-way
// sync, KALA-1495) is already in progress this quarter. Support argues the pain
// is real and multi-customer; Product argues the requested mechanism is a
// declined non-goal and a band-aid. The Judge honors the need without building
// the declined feature: reply pointing to the two-way-sync work, no override.
// Distinct from Scenario 3 (waitlist = "you asked for X, X is planned, here's
// the ETA"); here it's "we're declining X, but we're already solving your real
// problem a different way." The nuance roadmapLookup's non-goals make possible.
// ---------------------------------------------------------------------------

export const syncOverrideDemand: Scenario = {
  id: 'sync-override',
  title: 'Request for a user-set calendar sync interval (declined non-goal, real fix in flight)',
  triggerFeedback: {
    text:
      "New feedback from Meridian Wellness: 'Availability is often stale — someone booked a slot my calendar " +
      "already showed as taken because it hadn't refreshed yet. Can you let me set the " +
      "sync interval myself? I'd put mine at 1 minute.'",
    sourceUser: 'widget@cal-feedback',
    orgExternalId: 'org-meridian',
  },
  seedOrgs: [orgs.meridian],
  seedZendeskTickets: [
    {
      externalId: 'zd-sync-1',
      subject: 'Availability slow to update after a booking',
      description:
        "My calendar keeps showing slots as free for a few minutes after they're booked, " +
        "so people double-book. Can the refresh be faster?",
      requesterEmail: 'nina@brightpath.example',
      orgExternalId: 'org-brightpath',
      tags: ['availability', 'sync'],
      createdDaysAgo: 4,
    },
    {
      externalId: 'zd-sync-2',
      subject: 'Stale availability causing double bookings',
      description:
        "There's a lag before the booking page reflects a new booking. We've had a couple " +
        "of clients grab a slot that was actually taken. Any way to tighten the sync?",
      // Healthy account, not at-risk Northwind — keeps this scenario a roadmap_reply
      // rather than a churn escalation. See the ZENDESK_CATALOG id 141 note in
      // src/tools/index.ts.
      requesterEmail: 'ops@lumina.example',
      tags: ['availability', 'double-booking'],
      createdDaysAgo: 6,
    },
  ],
  seedJiraIssues: [
    {
      externalKey: 'KALA-1495',
      summary: 'Real-time two-way calendar sync (replaces 5-min polling)',
      description:
        'Committed Q3 work: move from the 5-minute polling model to real-time two-way sync, ' +
        'so availability reflects bookings immediately. This is the sanctioned fix for ' +
        'staleness/sync-lag complaints. Per-user sync-interval overrides were explicitly ' +
        'declined as a band-aid, superseded by this work.',
      issueType: 'Epic',
      status: 'In Progress',
      labels: ['roadmap', 'q3', 'sync'],
    },
  ],
  seedSlackHistory: [
    {
      daysAgo: 12,
      author: 'Product (Dana)',
      text:
        "Decision: we are NOT shipping per-user sync-interval overrides. Superseded by the " +
        "Q3 two-way sync work (KALA-1495). Route these requests to the roadmap thread.",
    },
  ],
  expected: {
    action: 'roadmap_reply',
    linksToJira: 'KALA-1495',
    rationale:
      'The pain is real and multi-customer (stale availability → double-bookings), so Support ' +
      'rightly pushes to act. But the specific request — a user-configurable sync interval — ' +
      'is an explicit product non-goal: the proper fix, real-time two-way sync (KALA-1495), ' +
      'is already in progress this quarter, and per-user overrides were deliberately declined ' +
      'as a band-aid. Correct action: reply to the customer naming the two-way-sync work and ' +
      "its timeframe, log demand against KALA-1495 — don't build the override. Support is " +
      'heard (the reply addresses their pain); Product holds the line on the declined mechanism.',
  },
};

// ---------------------------------------------------------------------------
// Distractor tickets — salt the Zendesk sandbox with unrelated, plausible
// tickets so retrieval has to DISCRIMINATE. "Found 4 relevant out of ~30" is
// the story; an instance containing only planted tickets reads as fake.
// Add more of these freely; ~20-30 total unrelated tickets is a good target.
// ---------------------------------------------------------------------------

export const distractorTickets: SeedZendeskTicket[] = [
  {
    externalId: 'zd-noise-1',
    subject: 'How do I change my booking page URL?',
    description: 'Want to update my username so my link looks cleaner. Where is that?',
    requesterEmail: 'casey@example.com',
    tags: ['how-to'],
    createdDaysAgo: 4,
  },
  {
    externalId: 'zd-noise-2',
    subject: 'Stripe payment not required on a paid event type',
    description:
      "Set a price on an event type but it lets people book without paying. Did I miss a setting?",
    requesterEmail: 'val@studio.example',
    tags: ['payments', 'stripe'],
    createdDaysAgo: 9,
  },
  {
    externalId: 'zd-noise-3',
    subject: 'Can I collect custom questions before a booking?',
    description: 'Need to ask for a phone number and project details on the booking form.',
    requesterEmail: 'omar@example.com',
    tags: ['booking-questions'],
    createdDaysAgo: 12,
  },
  {
    externalId: 'zd-noise-4',
    subject: 'Round-robin not distributing evenly',
    description:
      "Our team round-robin seems to send most bookings to one person. Can I weight it?",
    requesterEmail: 'nina@brightpath.example',
    orgExternalId: 'org-brightpath',
    tags: ['teams', 'round-robin'],
    createdDaysAgo: 15,
  },
  {
    externalId: 'zd-noise-5',
    subject: 'Reminder SMS never arrived',
    description: 'Set up an SMS reminder Workflow but my invitee said they never got a text.',
    requesterEmail: 'theo@example.com',
    tags: ['workflows', 'sms'],
    createdDaysAgo: 3,
  },
  {
    externalId: 'zd-noise-6',
    subject: 'Billing question - upgrading from Pro to Team',
    description: 'If I upgrade mid-cycle am I charged a prorated amount?',
    requesterEmail: 'billing@northwind.example',
    tags: ['billing'],
    createdDaysAgo: 7,
  },
];

// ---------------------------------------------------------------------------
// Export the ordered set the demo runs through.
// ---------------------------------------------------------------------------

export const scenarios: Scenario[] = [
  bugSpike,
  knownIssue,
  featureRequest,
  arrJudgment,
  cheapFixOffTheme,
  syncOverrideDemand,
];

/** Look up a scenario by id (used by the local runner + seed/teardown CLI args). */
export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}

export default scenarios;