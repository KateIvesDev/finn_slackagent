/**
 * Minimal per-response governance telemetry — the fields Slack's own
 * agent-governance docs call out as the baseline judges/admins expect an
 * agent to log: who asked, which model answered, what tools it reached for,
 * whether it succeeded, and how long it took. One line of structured JSON to
 * stdout (CloudWatch picks this up for free under Lambda); no dashboard, no
 * admin console — we don't have access to either on a dev workspace, and
 * that's explicitly out of scope for this pass.
 */
export interface AgentResponseLogEntry {
  userId?: string;
  agentId?: string;
  model?: string;
  toolsCalled: string[];
  outcome: 'success' | 'failure' | 'partial';
  totalLatencyMs: number;
  errorType?: string;
}

export function logAgentResponse(entry: AgentResponseLogEntry): void {
  console.log(
    JSON.stringify({
      type: 'agent_response',
      agent_id: entry.agentId ?? 'finn',
      user_id: entry.userId,
      model: entry.model,
      tools_called: entry.toolsCalled,
      outcome: entry.outcome,
      total_latency_ms: entry.totalLatencyMs,
      error_type: entry.errorType,
    }),
  );
}
