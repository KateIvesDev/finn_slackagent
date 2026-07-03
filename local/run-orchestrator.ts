/**
 * Local orchestrator runner — the fast iteration loop. Runs `orchestrate()` on
 * a sample feedback item and prints the (stubbed) verdict. NO Slack, no real
 * APIs required. This is how you develop agent/judge logic quickly.
 *
 * Run with: `npm run local`
 *           `npm run local -- bug-spike`   (use a scenario's trigger feedback)
 */
import { orchestrate } from '../src/agents/orchestrator.js';
import { getScenario } from '../seed/scenarios.js';
import type { Feedback } from '../src/types/index.js';

async function main(): Promise<void> {
  // Optionally pull the trigger text from a named scenario.
  const scenarioId = process.argv[2];
  const scenario = scenarioId ? getScenario(scenarioId) : undefined;
  if (scenarioId && !scenario) {
    throw new Error(`Unknown scenario id: ${scenarioId}`);
  }

  const text =
    scenario?.triggerFeedback.text ??
    'The mobile app keeps logging me out every few minutes since the last update. Really frustrating.';

  // A synthetic Feedback object — no Slack needed.
  const feedback: Feedback = {
    id: 'local-run-1',
    text,
    channel: 'LOCAL',
    threadTs: 'local-run-1',
  };

  console.log('▶ Running orchestrator on feedback:\n');
  console.log(`  "${feedback.text}"\n`);
  if (scenario) console.log(`  (scenario: ${scenario.id}, expected: ${scenario.expected.action})\n`);

  const verdict = await orchestrate(feedback);

  console.log('─── VERDICT ───────────────────────────────');
  console.log(JSON.stringify(verdict, null, 2));
  console.log('───────────────────────────────────────────');
}

main().catch((err) => {
  console.error('❌ Local run failed:', err);
  process.exit(1);
});
