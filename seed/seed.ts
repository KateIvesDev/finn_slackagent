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
 * history the sharks search via RTS) is a separate step — see
 * seed/slack/seed.ts.
 */
import { loadConfig, requireConfig } from '../src/config/index.js';
import { scenarios, getScenario, distractorTickets } from './scenarios.js';
import type { Scenario, SeedZendeskOrg, SeedZendeskTicket, SeedJiraIssue } from './scenarios.js';

// ---------------------------------------------------------------------------
// Stubbed API boundaries. Fill these in with real REST calls.
// ---------------------------------------------------------------------------

/** Create (or update, if externalId already exists) a Zendesk organization. */
async function upsertZendeskOrg(org: SeedZendeskOrg, scenarioId: string): Promise<void> {
  // TODO: real Zendesk REST call.
  //   GET  /api/v2/organizations/search.json?external_id={org.externalId} to check first.
  //   POST /api/v2/organizations.json (or PUT to update) with org_fields for
  //   plan/arrUsd/renewalDate — set those up as custom organization fields first.
  console.log(`  [stub] upsert Zendesk org: "${org.name}" (${scenarioId})`);
}

/** Create (or skip if present) a Zendesk ticket, keyed by externalId. */
async function upsertZendeskTicket(ticket: SeedZendeskTicket, scenarioId: string): Promise<string> {
  // TODO: real Zendesk REST call.
  //   POST https://{subdomain}.zendesk.com/api/v2/tickets.json
  //   Auth: basic `${email}/token:${apiToken}` (base64).
  //   Tag every ticket with ticket.externalId (as an external_id field) so
  //   re-running the seed updates rather than duplicates. Look it up first.
  //   See the createdDaysAgo doc comment in scenarios.ts re: the Import API.
  console.log(`  [stub] upsert Zendesk ticket: "${ticket.subject}" (${ticket.externalId}, ${scenarioId})`);
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

  for (const org of scenario.seedOrgs ?? []) {
    await upsertZendeskOrg(org, scenario.id);
  }
  for (const ticket of scenario.seedZendeskTickets ?? []) {
    await upsertZendeskTicket(ticket, scenario.id);
  }
  for (const issue of scenario.seedJiraIssues ?? []) {
    await upsertJiraIssue(issue, scenario.id);
  }

  console.log(`✔ Done: ${scenario.id} (expected: ${scenario.expected.action})`);
}

async function main(): Promise<void> {
  // These are only needed for REAL calls; kept required so you notice early.
  requireConfig([
    'ZENDESK_SUBDOMAIN',
    'ZENDESK_EMAIL',
    'ZENDESK_API_TOKEN',
    'JIRA_BASE_URL',
    'JIRA_EMAIL',
    'JIRA_API_TOKEN',
  ]);
  loadConfig();

  // Optional scenario id from CLI: `npm run seed -- bug-spike`.
  const targetId = process.argv[2];
  const toSeed = targetId
    ? [getScenario(targetId)].filter((s): s is Scenario => Boolean(s))
    : scenarios;

  if (targetId && toSeed.length === 0) {
    throw new Error(`Unknown scenario id: ${targetId}`);
  }

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
