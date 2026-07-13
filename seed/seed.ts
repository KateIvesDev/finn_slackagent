/**
 * Idempotent sandbox seeding. Reads Zendesk + Jira sandbox creds from env and
 * creates the orgs/tickets/issues each scenario needs. Safe to run repeatedly:
 * existing seeded records are detected (by external id/key) and skipped.
 *
 * The actual REST calls are STUBBED — replace the marked bodies with real
 * Zendesk/Jira API calls. The function boundaries are typed so you only fill
 * in the HTTP.
 *
 * Run with: `npm run seed`            (all scenarios)
 *           `npm run seed -- bug-spike` (one scenario by id)
 *
 * Note: this seeds Zendesk/Jira. The Slack context substrate (channel
 * history the personas search via RTS) is a separate step — see
 * seed/slack/seed.ts.
 */
import { loadConfig, requireConfig } from '../src/config/index.js';
import { scenarios, getScenario, distractorTickets, allOrgs, orgByEmailDomain } from './scenarios.js';
import type { Scenario, SeedZendeskTicket, SeedJiraIssue } from './scenarios.js';
import { zendeskFromEnv, type ZendeskClient } from '../src/zendesk/client.js';

// ---------------------------------------------------------------------------
// Real Zendesk seeding (Jira still stubbed — only Zendesk is wired to a live
// sandbox for the MCP integration). One client + an externalId→orgId map so
// tickets can attach their requester to the right org.
// ---------------------------------------------------------------------------

let zd: ZendeskClient;
const orgIdByExternalId = new Map<string, number>();

/** Seed every org up front with its custom fields (plan/arr_usd/renewal_date/
 *  health) + notes, and remember its real id so tickets can attach to it. */
async function seedAllOrgs(): Promise<void> {
  console.log(`\n▶ Seeding ${allOrgs.length} Zendesk orgs…`);
  for (const org of allOrgs) {
    const id = await zd.upsertOrganization({
      externalId: org.externalId,
      name: org.name,
      plan: org.plan,
      arrUsd: org.arrUsd,
      renewalDate: org.renewalDate,
      health: org.health,
      notes: org.note,
    });
    orgIdByExternalId.set(org.externalId, id);
    console.log(`  ✔ org "${org.name}" (#${id})`);
  }
}

/** Resolve which org a ticket's requester belongs to, by email domain. */
function orgIdForRequester(email: string): number | undefined {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const externalId = orgByEmailDomain[domain];
  return externalId ? orgIdByExternalId.get(externalId) : undefined;
}

/** Create (or skip if present) a Zendesk ticket, attaching the requester to the
 *  right org so it inherits that org's ARR/renewal/health custom fields. */
async function upsertZendeskTicket(ticket: SeedZendeskTicket, scenarioId: string): Promise<string> {
  const organizationId = orgIdForRequester(ticket.requesterEmail);
  const name = ticket.requesterEmail.split('@')[0] ?? 'Requester';
  const requesterId = await zd.upsertUser(ticket.requesterEmail, name, organizationId);
  await zd.createTicket({
    externalId: ticket.externalId,
    subject: ticket.subject,
    description: ticket.description,
    requesterId,
    organizationId,
    tags: ticket.tags,
    createdDaysAgo: ticket.createdDaysAgo,
  });
  console.log(`  ✔ ticket "${ticket.subject}" (${ticket.externalId}, ${scenarioId})`);
  return ticket.externalId;
}

/** Create (or skip if present) a pre-existing Jira issue, keyed by externalKey. */
async function upsertJiraIssue(issue: SeedJiraIssue, scenarioId: string): Promise<string> {
  // TODO: real Jira REST call.
  //   POST {JIRA_BASE_URL}/rest/api/3/issue
  //   Auth: basic `${email}:${apiToken}` (base64).
  //   Add a label carrying issue.externalKey (Jira assigns the real key on
  //   create); search by that label first to stay idempotent.
  console.log(`  [stub] upsert Jira issue: "${issue.summary}" (${issue.externalKey}, ${scenarioId})`);
  return issue.externalKey;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function seedScenario(scenario: Scenario): Promise<void> {
  console.log(`\n▶ Seeding scenario: ${scenario.id} — ${scenario.title}`);

  // Orgs are seeded globally up front (seedAllOrgs) — a ticket's requester is
  // attached to its org by email domain, so we don't seed per-scenario orgs here.
  for (const ticket of scenario.seedZendeskTickets ?? []) {
    await upsertZendeskTicket(ticket, scenario.id);
  }
  for (const issue of scenario.seedJiraIssues ?? []) {
    await upsertJiraIssue(issue, scenario.id);
  }

  console.log(`✔ Done: ${scenario.id} (expected: ${scenario.expected.action})`);
}

async function main(): Promise<void> {
  // Zendesk is wired to a live sandbox; Jira is still stubbed.
  requireConfig(['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_API_TOKEN']);
  loadConfig();
  zd = zendeskFromEnv();

  // Optional scenario id from CLI: `npm run seed -- bug-spike`.
  const targetId = process.argv[2];
  const toSeed = targetId
    ? [getScenario(targetId)].filter((s): s is Scenario => Boolean(s))
    : scenarios;

  if (targetId && toSeed.length === 0) {
    throw new Error(`Unknown scenario id: ${targetId}`);
  }

  // Every org first (so tickets can attach to them), then the scenarios.
  await seedAllOrgs();

  for (const scenario of toSeed) {
    await seedScenario(scenario);
  }

  // Salt the pool with unrelated distractor tickets so retrieval has to
  // discriminate ("found 4 relevant out of 30") — only when seeding everything.
  if (!targetId) {
    console.log(`\n▶ Seeding ${distractorTickets.length} distractor ticket(s)…`);
    for (const ticket of distractorTickets) {
      await upsertZendeskTicket(ticket, 'distractor');
    }
  }

  console.log('\n✅ Seeding complete.');
}

main().catch((err) => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});
