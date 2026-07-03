/**
 * Idempotent teardown. Deletes everything seed.ts created in Zendesk/Jira
 * (identified by externalId/externalKey) so you can reset to a clean demo
 * state. Safe to run when nothing is seeded — it just finds nothing.
 *
 * The REST calls are STUBBED — fill in the marked bodies.
 *
 * Run with: `npm run teardown`            (all scenarios)
 *           `npm run teardown -- bug-spike` (one scenario by id)
 *
 * Note: this tears down Zendesk/Jira. For the Slack context substrate, see
 * seed/slack/reset.ts.
 */
import { loadConfig, requireConfig } from '../src/config/index.js';
import { scenarios, getScenario, distractorTickets } from './scenarios.js';
import type { Scenario } from './scenarios.js';

/** Delete a Zendesk ticket by externalId. */
async function deleteZendeskTicket(externalId: string): Promise<void> {
  // TODO: real Zendesk REST call.
  //   GET  /api/v2/tickets/show_many.json?external_ids={externalId}
  //   DELETE the matching ticket(s), if any.
  console.log(`  [stub] delete Zendesk ticket ${externalId}`);
}

/** Delete a Zendesk organization by externalId. */
async function deleteZendeskOrg(externalId: string): Promise<void> {
  // TODO: real Zendesk REST call.
  //   GET  /api/v2/organizations/search.json?external_id={externalId}
  //   DELETE the matching org, if any.
  console.log(`  [stub] delete Zendesk org ${externalId}`);
}

/** Delete a Jira issue by the externalKey label we tagged it with at seed time. */
async function deleteJiraIssue(externalKey: string): Promise<void> {
  // TODO: real Jira REST call.
  //   GET  /rest/api/3/search?jql=labels={externalKey}
  //   DELETE the matching issue, if any.
  console.log(`  [stub] delete Jira issue ${externalKey}`);
}

async function teardownScenario(scenario: Scenario): Promise<void> {
  console.log(`\n▶ Tearing down: ${scenario.id}`);

  for (const ticket of scenario.seedZendeskTickets ?? []) {
    await deleteZendeskTicket(ticket.externalId);
  }
  for (const issue of scenario.seedJiraIssues ?? []) {
    await deleteJiraIssue(issue.externalKey);
  }
  for (const org of scenario.seedOrgs ?? []) {
    await deleteZendeskOrg(org.externalId);
  }

  console.log(`✔ Cleared: ${scenario.id}`);
}

async function main(): Promise<void> {
  requireConfig([
    'ZENDESK_SUBDOMAIN',
    'ZENDESK_EMAIL',
    'ZENDESK_API_TOKEN',
    'JIRA_BASE_URL',
    'JIRA_EMAIL',
    'JIRA_API_TOKEN',
  ]);
  loadConfig();

  const targetId = process.argv[2];
  const toClear = targetId
    ? [getScenario(targetId)].filter((s): s is Scenario => Boolean(s))
    : scenarios;

  if (targetId && toClear.length === 0) {
    throw new Error(`Unknown scenario id: ${targetId}`);
  }

  for (const scenario of toClear) {
    await teardownScenario(scenario);
  }

  if (!targetId) {
    console.log(`\n▶ Clearing ${distractorTickets.length} distractor ticket(s)…`);
    for (const ticket of distractorTickets) {
      await deleteZendeskTicket(ticket.externalId);
    }
  }

  console.log('\n🧹 Teardown complete.');
}

main().catch((err) => {
  console.error('❌ Teardown failed:', err);
  process.exit(1);
});
