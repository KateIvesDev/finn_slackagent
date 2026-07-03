/**
 * scenarios.ts
 *
 * Seed data for the feedback-debate demo, grounded in Cal.com (open-source
 * scheduling). Each scenario is engineered so that when the persona agents go
 * search Zendesk / Jira / Slack history, the evidence they find FORCES a
 * specific, legible verdict — and the four scenarios deliberately resolve to
 * four DIFFERENT action paths so the demo shows range:
 *
 *   1. bug-spike        -> jira_create   (escalate: cluster of tickets, nothing tracked)
 *   2. known-issue      -> jira_link     (restraint: already tracked, don't duplicate)
 *   3. feature-request  -> none          (deflect: on the roadmap, reply with ETA)
 *   4. arr-judgment     -> zendesk_create(judgment: same complaint, ARR tips the call)
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
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  /** Custom org field — the Support agent reads this to weigh priority. */
  arrUsd?: number;
  /** ISO date. Renewal proximity is part of the ARR-judgment argument. */
  renewalDate?: string;
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
// (acme/brightpath/hobby) in the type, so `orgs.acme` is `SeedZendeskOrg`, not
// `SeedZendeskOrg | undefined` — a plain Record<string,...> annotation widens
// to a string index signature, which noUncheckedIndexedAccess then flags.
export const orgs = {
  acme: {
    externalId: 'org-acme',
    name: 'Acme Corp',
    plan: 'enterprise',
    arrUsd: 48000,
    // Set at seed time to ~3 weeks out; hardcoded here for reference.
    renewalDate: '2026-07-24',
  },
  brightpath: {
    externalId: 'org-brightpath',
    name: 'BrightPath Studio',
    plan: 'team',
    arrUsd: 6000,
  },
  hobby: {
    externalId: 'org-hobby',
    name: 'Individual (Free)',
    plan: 'free',
    arrUsd: 0,
  },
} satisfies Record<string, SeedZendeskOrg>;

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
      "New feedback from in-app widget: 'Set up a weekly team sync as a recurring " +
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
        "in Google Calendar. The rest are confirmed in Cal.com but invisible on my " +
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
        "Bookings confirmed in Cal.com but not on my Google Calendar. Disconnected and " +
        "reconnected the integration, no change. Only seems to be repeat events.",
      requesterEmail: 'sam@lumina.example',
      tags: ['google-calendar', 'integration'],
      createdDaysAgo: 1,
    },
    {
      externalId: 'zd-spike-5',
      subject: 'URGENT - team double booking because calendar sync is dropping events',
      description:
        "This is causing real problems. Recurring bookings are confirmed on Cal.com but " +
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
// search surfaces CAL-1487; the RTS search surfaces the prior Slack thread.
// Verdict: DO NOT create a duplicate — link this report to CAL-1487, add the
// customer as affected, comment. This is the highest-impact narrative:
// "did we already log this?" is the pain everyone recognizes.
// ---------------------------------------------------------------------------

export const knownIssue: Scenario = {
  id: 'known-issue',
  title: 'Outlook bookings showing at the wrong time (already tracked)',
  triggerFeedback: {
    text:
      "New feedback: 'When my clients on Outlook book me, the meeting shows up an hour " +
      "off on their side. I'm in US Central. It's on the Cal.com confirmation correctly " +
      "but wrong in their Outlook invite.'",
    sourceUser: 'widget@cal-feedback',
    orgExternalId: 'org-acme',
  },
  seedJiraIssues: [
    {
      externalKey: 'CAL-1487',
      summary: 'Office 365 booking invites offset by 1 hour for non-UTC organizers',
      description:
        'Confirmed bug: for organizers in non-UTC timezones, the ICS/invite written to ' +
        'the invitee via the Office 365 integration is offset by one hour (DST boundary ' +
        'handling). Cal.com-side confirmation is correct; only the pushed invite is wrong. ' +
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
        "actual time. Cal.com shows the right time. Already reported I think but adding mine.",
      requesterEmail: 'lee@acme.example',
      orgExternalId: 'org-acme',
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
        "off for non-UTC folks. Eng opened CAL-1487, it's in progress. Route new ones there.",
    },
    {
      daysAgo: 5,
      author: 'Eng (Tobias)',
      text:
        "CAL-1487 update: root-caused to DST handling in the O365 invite writer. Fix in " +
        "review. If more customers hit it, add them to the ticket so we can gauge blast radius.",
    },
  ],
  expected: {
    action: 'dedup_link',
    linksToJira: 'CAL-1487',
    priority: 'normal',
    rationale:
      'The complaint matches an already-open, in-progress Jira bug (CAL-1487) AND the ' +
      'channel history explicitly says to route new reports there. Creating a new ticket ' +
      'would be a duplicate. Correct action: link this report to CAL-1487, add the customer ' +
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
      "New feedback: 'Love Cal.com. One thing — when a popular slot is full, people give " +
      "up. Could you add a waitlist so they get notified if it frees up? Would save us a " +
      "ton of back-and-forth.'",
    sourceUser: 'widget@cal-feedback',
    orgExternalId: 'org-brightpath',
  },
  seedJiraIssues: [
    {
      externalKey: 'CAL-1102',
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
      'Product finds it already scoped on the roadmap (CAL-1102, labeled roadmap/q4). ' +
      'Creating a new ticket would be noise. Correct action: post a friendly reply naming ' +
      'the planned timeframe and increment the +1 count on CAL-1102. No ticket created.',
  },
};

// ---------------------------------------------------------------------------
// Scenario 4 — ARR JUDGMENT -> zendesk_create  (the debate that matters)
// The SAME complaint (embed widget perf) resolves differently depending on WHO
// is asking. From a free user it's backlog. From Acme (enterprise, $48k ARR,
// renewal in ~3 weeks) it's an escalation. The Support agent pulls the org's
// plan/ARR/renewal; Engineering argues low-effort-low-value; Product says it's
// off the core roadmap. The Judge weighs the $ and renewal risk and escalates.
// This is the scenario that proves the debate isn't theater.
//
// Tip for the demo: run this feedback once as Acme, then once as the free org
// (swap triggerFeedback.orgExternalId to 'org-hobby') to show the SAME input
// producing a DIFFERENT verdict. That side-by-side is the money shot.
// ---------------------------------------------------------------------------

export const arrJudgment: Scenario = {
  id: 'arr-judgment',
  title: 'Embed widget slow / layout shift — priority depends on the account',
  triggerFeedback: {
    text:
      "New feedback from Acme Corp: 'Your embed is janky on our marketing site — it loads " +
      "slowly and shoves the page around as it renders (layout shift). It's hurting our " +
      "conversion and honestly it's a bad look on our homepage. We're evaluating this ahead " +
      "of renewal.'",
    sourceUser: 'success@acme.example',
    orgExternalId: 'org-acme',
  },
  seedOrgs: [orgs.acme, orgs.hobby],
  seedZendeskTickets: [
    {
      externalId: 'zd-arr-1',
      subject: 'Embed causes layout shift on our site',
      description:
        "The inline embed pushes our page content around as it loads and is slow on " +
        "mobile. On our homepage above the fold. Needs to be smoother.",
      requesterEmail: 'success@acme.example',
      orgExternalId: 'org-acme',
      tags: ['embed', 'performance'],
      createdDaysAgo: 1,
    },
  ],
  seedJiraIssues: [
    {
      externalKey: 'CAL-980',
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
      '(CAL-980) — from a free user, the right call is "backlog, no action." But the Support ' +
      'agent surfaces that the reporter is Acme: enterprise, $48k ARR, renewal in ~3 weeks, ' +
      'explicitly tying the complaint to the renewal decision. The Judge weighs churn risk ' +
      'over engineering-effort math and escalates: create a high-priority Zendesk ticket ' +
      'routed to the account/CSM, and link (not re-create) CAL-980 for the eng side. The ' +
      'ARR context flips the verdict — that is the debate earning its keep.',
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

export const scenarios: Scenario[] = [bugSpike, knownIssue, featureRequest, arrJudgment];

/** Look up a scenario by id (used by the local runner + seed/teardown CLI args). */
export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}

export default scenarios;