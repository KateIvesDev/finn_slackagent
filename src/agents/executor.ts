/**
 * Action executor: runs the approved verdict. This is the ONLY place the agent
 * actually changes the outside world, and it only runs after a human clicks
 * Approve — the system never acts silently.
 *
 * Uses the same tool registry as the agents (so the real MCP wiring is shared).
 */
// Import the concrete tool objects directly (not via the registry map) so they
// are strongly typed — registry lookups are `Tool | undefined` under strict mode.
import { zendeskCreateTicket, jiraCreateIssue, slackPostMessage } from '../tools/index.js';
import type { Feedback } from '../types/index.js';
import type { Verdict, VerdictActionType } from '../slack/types.js';

export interface ExecutionResult {
  action: VerdictActionType;
  /** Human-readable outcome to post back into the Slack thread / ledger. */
  summary: string;
  /** Link to the created artifact, if any. */
  url?: string;
}

/** Execute the verdict's action. Dispatches on `verdict.action.type`. */
export async function executeVerdict(
  verdict: Verdict,
  feedback: Feedback,
): Promise<ExecutionResult> {
  const payload = verdict.action.payload ?? {};

  switch (verdict.action.type) {
    case 'create_jira': {
      const ref = await jiraCreateIssue.execute({
        summary: (payload.title as string | undefined) ?? verdict.headline,
        description: (payload.body as string | undefined) ?? verdict.rationale,
        issueType: (payload.issueType as string | undefined) ?? 'Bug',
      });
      return { action: 'create_jira', summary: 'Created Jira issue.', url: ref.url };
    }
    case 'create_zendesk': {
      const ref = await zendeskCreateTicket.execute({
        subject: (payload.title as string | undefined) ?? verdict.headline,
        body: (payload.body as string | undefined) ?? verdict.rationale,
      });
      return { action: 'create_zendesk', summary: 'Created Zendesk ticket.', url: ref.url };
    }
    case 'dedup_link': {
      // TODO: once jiraSearchIssues/jiraCreateIssue are wired to a real MCP
      // client, replace this with an actual "add comment / link" call on the
      // existing issue instead of just posting a reply.
      const key = payload.jiraKeyToLink as string | undefined;
      await slackPostMessage.execute({
        channel: feedback.channel,
        threadTs: feedback.threadTs,
        text: key
          ? `Linked this report to the existing issue ${key}. No new ticket created.`
          : 'Linked this report to the existing tracked issue. No new ticket created.',
      });
      return {
        action: 'dedup_link',
        summary: key ? `Linked to ${key}.` : 'Linked to existing issue.',
      };
    }
    case 'roadmap_reply': {
      await slackPostMessage.execute({
        channel: feedback.channel,
        threadTs: feedback.threadTs,
        text: (payload.customerReply as string | undefined) ?? verdict.rationale,
      });
      return { action: 'roadmap_reply', summary: 'Posted roadmap reply.' };
    }
    case 'no_action': {
      return { action: 'no_action', summary: 'No action taken.' };
    }
    default: {
      // Exhaustiveness check: if a new action is added to the union and not
      // handled above, TypeScript errors here at compile time.
      const _never: never = verdict.action.type;
      throw new Error(`Unhandled verdict action: ${String(_never)}`);
    }
  }
}
