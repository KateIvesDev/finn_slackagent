/**
 * Ablation: does the multi-agent debate change the OUTCOME, or is it decorative?
 *
 * Holds the Judge constant and varies only how evidence is gathered:
 *   PANEL — the three adversarial personas, each with its scoped toolset (prod).
 *   SOLO  — ONE analyst handed the UNION of all tools, told to hold all three
 *           lenses at once, then the SAME runJudge.
 *
 * If the two land on the same action, the persona split didn't change the call
 * (the evidence + judge did the work). If they diverge, the debate earned its keep.
 *
 * Run:  BEDROCK_STUB=false BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
 *       AWS_PROFILE=slackagent AWS_REGION=us-east-1 npx tsx local/ablation.ts [scenarioId]
 */
import { personas } from '../src/agents/personas.js';
import { runJudge } from '../src/agents/judge.js';
import { runAgent } from '../src/bedrock/runAgent.js';
import { toolRegistry } from '../src/tools/index.js';
import { selectTools } from '../src/tools/registry.js';
import { getScenario } from '../seed/scenarios.js';
import type { AgentResult, Feedback } from '../src/types/index.js';
import type { Verdict } from '../src/slack/types.js';

const scenarioId = process.argv[2] ?? 'arr-judgment';
const scenario = getScenario(scenarioId);
if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);

const feedback: Feedback = {
  id: `ablation-${scenarioId}`,
  text: scenario.triggerFeedback.text,
  channel: 'local',
  threadTs: 'local',
};
const input = `Product feedback to evaluate:\n\n"""${feedback.text}"""`;

// Union of every persona's tools — what the solo analyst gets.
const allToolNames = [...new Set(personas.flatMap((p) => p.toolNames))];

const SOLO_PROMPT = `
You are a senior product-operations analyst triaging incoming product feedback for
Kalabook (a scheduling product). You hold ALL perspectives at once:
- Customer/Support impact: how many are affected, how recently, and WHO (plan, ARR, renewal).
- Engineering reality: is it a real defect or an enhancement, is it already tracked, effort vs severity.
- Product strategy: roadmap fit, opportunity cost, and any explicit non-goals.

Use your tools to gather evidence across ALL three lenses before you conclude — do not
skip a lens. Then call submit_position with your single recommended course of action and
your strongest evidence.
`.trim();

function summarize(label: string, positions: AgentResult[], verdict: Verdict) {
  console.log(`\n========== ${label} ==========`);
  for (const p of positions) {
    const s = p.structured;
    console.log(`\n• ${p.persona.toUpperCase()}  [tools: ${p.toolCalls.map((c) => c.name).join(', ') || 'none'}]`);
    console.log(`  stance: ${s?.stance ?? '?'} | rec: ${s?.recommendation ?? p.position.slice(0, 120)}`);
    (s?.evidence ?? []).forEach((e) => console.log(`    - ${e}`));
  }
  console.log(`\n  >>> VERDICT`);
  console.log(`      action:   ${verdict.action.type}`);
  console.log(`      headline: ${verdict.headline}`);
  console.log(`      deciding: ${verdict.decidingFactor ?? '—'}`);
  console.log(`      reads:    ${JSON.stringify(verdict.reads)}`);
}

void (async () => {
  console.log(`\nScenario: ${scenarioId}  (expected: ${scenario.expected.action})`);
  console.log(`Feedback: ${feedback.text}`);

  // --- PANEL ---
  const panelPositions = await Promise.all(
    personas.map((persona) =>
      runAgent({
        persona: persona.id,
        systemPrompt: persona.systemPrompt,
        tools: selectTools(toolRegistry, persona.toolNames),
        input,
      }),
    ),
  );
  const panelVerdict = await runJudge(panelPositions);
  summarize('PANEL (3 adversarial personas)', panelPositions, panelVerdict);

  // --- SOLO ---
  const soloResult = await runAgent({
    persona: 'product', // label only; it has the union of tools
    systemPrompt: SOLO_PROMPT,
    tools: selectTools(toolRegistry, allToolNames),
    input,
  });
  const soloVerdict = await runJudge([soloResult]);
  summarize('SOLO (1 analyst, all tools)', [soloResult], soloVerdict);

  // --- DELTA ---
  console.log(`\n========== DELTA ==========`);
  const sameAction = panelVerdict.action.type === soloVerdict.action.type;
  console.log(`  panel action: ${panelVerdict.action.type}`);
  console.log(`  solo action:  ${soloVerdict.action.type}`);
  console.log(`  SAME ACTION?  ${sameAction ? 'YES — debate did not change the call' : 'NO — the panel changed the outcome'}`);
  const soloTools = new Set(soloResult.toolCalls.map((c) => c.name));
  const missed = allToolNames.filter((t) => !soloTools.has(t));
  console.log(`  solo skipped tools: ${missed.length ? missed.join(', ') : 'none — gathered across all lenses'}`);
})();
