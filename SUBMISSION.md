# Finn — Submission Writeup

*Draft for the submission form (Devpost-style sections). Tailor the voice and
trim to the field limits before pasting. Spots needing your input flagged with →.*

---

## Elevator pitch (one line)

**Finn is a human-oversight layer for AI decision-making in Slack: a panel of
specialist agents debates each incoming call, Finn auto-handles the ones they
agree on and routes only the contested or high-stakes ones to a human — with an
auditable, dissent-surfaced rationale for every decision.**

---

## Inspiration

Every team drowns in inbound signal — feedback, tickets, requests — and the
triage that follows is invisible, inconsistent, and lossy. The same complaint
gets filed as a bug on Monday and waved off on Tuesday, depending on who read it.
The *reasoning* — "we skipped this because it's already tracked / off-roadmap /
from a free-tier user" — lives in one person's head and evaporates.

AI could absorb this volume, but it collapses the decision into a single
confident answer with no visible reasoning — and no team can let an AI silently
take actions on customer accounts. So the real problem isn't "can AI decide" —
it's **can AI decide in a way you can trust, audit, and stay in the loop on,
without a human having to review all of it.** That's what Finn is: not an
autonomous decider, an *oversight layer* that scales human judgment instead of
replacing it.

## What it does

Feedback lands in a Slack channel, and Finn convenes a panel:

1. **Three specialist agents debate it in parallel** — Support, Engineering, and
   Product — each with its own **evidence instrument**. Support reads ticket
   volume + account context (plan, ARR, renewal). Engineering reads the issue
   tracker (defect vs enhancement, severity, effort, what's in flight). Product
   reads the roadmap (committed themes, explicit non-goals, capacity). They
   disagree because they genuinely can't see the same evidence. Each posts its
   argument under its own nameplate; Finn reacts 🤔 as each lands, then resolves
   each to 👍 favored / 👎 overruled / ⚖️ unresolved.
2. **The panel's (dis)agreement decides who's needed.** This is the core idea:
   - When the specialists **agree and the action is low-stakes**, Finn **handles
     it autonomously** — executes, logs it, posts a quiet "handled — here's why"
     note. No human interrupted.
   - When there's **genuine disagreement, or a consequential action** (filing a
     ticket, escalating an account), Finn **routes it to a human** with a Block
     Kit Approve/Reject card and an @-mention. Nothing external happens until a
     person signs off.
3. **Every decision is recorded** — autonomous or human-approved — to a Slack
   Canvas decision ledger, with the reasoning and the resolved read on each
   argument. Triage stops being lossy.

The routing is the product. The *same* complaint can go two ways: a free-tier
performance gripe with panel consensus, Finn quietly disposes of; the identical
complaint from a $48k enterprise account under two weeks from renewal, Finn
escalates to a human. Disagreement and stakes — not a fixed rule — decide what deserves
attention. An **App Home tab** lets a judge one-click six scenarios or submit
their own feedback with an org-tier dropdown that flips the routing live.

## How we built it

- **One reusable agent runner** over the **Amazon Bedrock Converse API** tool-use
  loop. The three personas are *just configuration* (system prompt + scoped
  toolset); the same runner executes all of them and the Judge, on **Claude**.
- **Schema-constrained output via forced tool-use.** Rather than scrape headed
  free text (brittle — one model bold-formats its labels and the parser breaks),
  each agent returns typed JSON through a `submit_position` / `submit_verdict`
  tool whose input schema *is* the result shape. The Judge is *forced* to call
  its tool via `toolChoice`.
- **The routing policy** (`routeVerdict`) is the pivot in code: consensus +
  low-stakes → autonomous; any dissent or a write → human. The panel's job is to
  decide *which*.
- **Two of Slack's three named agent technologies, both load-bearing.** The
  specialists ground each argument in real workspace context via the **Real-Time
  Search API** (`assistant.search.context`, user token + `search:read.public`) —
  Slack's purpose-built endpoint for feeding an LLM fresh in-workspace data — each
  AI agent scoped to its own channels. And they pull ticket volume + account context
  through a **standalone Zendesk MCP server we built** (backed by a live Zendesk
  sandbox), over the open MCP protocol. RTS + MCP, not decoration.
- **Two transports, one flow.** Transport-agnostic logic runs identically under
  **Socket Mode** and an **HTTP Events API on AWS Lambda** (fast receiver acks
  Slack in <3s, async worker does the debate), behind API Gateway with a DynamoDB
  store — all provisioned by **Terraform**.
- **Slack-native UX end to end:** Block Kit cards, `chat:write.customize`
  nameplates, a live reaction arc, an App Home tab, and a Canvas ledger.
- **Governed and resilient.** One structured governance line per response (who
  asked, which model, which tools, outcome, latency); transient-error retries on
  Bedrock; per-agent failure isolation so one agent throwing degrades gracefully
  instead of wedging the thread.

*Grounding note: two of the three evidence stores are live. Slack workspace
context is pulled live via the **Real-Time Search API** (`assistant.search.context`);
Zendesk tickets + account context come live from a **real Zendesk sandbox** through
the **Zendesk MCP server we built** (with a curated fallback if it's unreachable).
The Jira issue tracker is still a seeded catalog behind the same typed tool boundary
— ready to swap for a live MCP — and execution (the write actions) is stubbed pending
real API wiring.*

## What makes the idea different

Multi-agent debate and human-in-the-loop approval are known patterns. What's
different here is **using inter-agent disagreement as a routing signal for scarce
human attention** — and being disciplined about what that debate is actually
*for*:

1. **Disagreement is the uncertainty signal.** Instead of interrupting a human on
   every call (unscalable) or auto-acting on all of them (untrustworthy), the
   panel's consensus-vs-conflict decides. Humans see only the hard cases.
2. **Every decision is legible and auditable** — surfaced dissent, a resolved
   read on each argument, a recorded rationale — whether Finn handled it or a
   human did.
3. **Human-in-the-loop by construction** — nothing external happens on a
   contested or consequential call without a person, and the record shows who
   decided and why.

## We tested our own thesis

We didn't want to claim "debate makes better decisions" on faith, so we ran an
ablation: the full panel vs. a single agent handed all the same tools, on the
same scenarios. Honest finding — on clear cases, both reached the same call, so
the debate rarely changed the *outcome*. That's not a failure; it's the reason
the routing works: **when the specialists agree, you don't need the ceremony, and
Finn auto-handles it.** The panel's value is deciding *which* cases are clear,
surfacing dissent on the ones that aren't, and keeping every call auditable — not
out-deciding a single model on easy problems. Whether adversarial debate improves
decisions on genuinely *ambiguous* cases is an open question we scoped an eval
for, rather than overclaimed. (The ablation harness ships in the repo.)

## Impact — the oversight problem is the wedge

What stands between agentic AI and real enterprise deployment isn't capability —
it's **trust**. No team will let an AI take actions on customer accounts, tickets,
or roadmaps without a human accountable for the call and a record of why. That's
the live blocker in 2026, and it's exactly what Finn is built around: auto-handle
what's clear, escalate what's contested, make every decision auditable.

**Product-feedback triage is the beachhead, not the ambition.** It's a real,
high-volume, judgment-heavy queue where the reasoning is chronically lost — a
credible first foothold precisely because the pain is universal and the stakes are
bounded. Win there, and the *same* pattern — a panel of specialists surfaces
agreement or conflict; the clear resolves autonomously, the contested routes to a
human, everything is recorded — extends to any decision queue that needs AI
throughput with human accountability: incident response, PR review, support
escalation, access and procurement. (That extension is the roadmap, not a claim —
today only feedback triage is built.)

And it's **Slack-native**, which is the adoption story: these decisions already
happen in Slack, messily, with the reasoning evaporating in threads. Finn makes an
existing ritual better instead of asking anyone to adopt a new surface — so the
barrier to trying it is a channel, not a migration.

**What it isn't yet:** a validated product. Real execution, approval permissions,
and verifying an agent's cited evidence are the work between here and production —
and "does specialist debate improve decisions on *ambiguous* cases" is an open
question we scoped an eval for, not a claim. The bet is on the pattern:
trustworthy human oversight is the unlock for agentic AI, and Slack is where it
belongs.

## Challenges we ran into

- **Making the debate load-bearing, honestly.** Our ablation showed debate rarely
  changes the *outcome* on clear cases — so we rebuilt the idea around what the
  data supported (routing + auditability) instead of a claim it didn't.
- **Model-portable structured output.** Text-scraping broke the moment a model
  formatted its labels differently; we moved to schema-constrained forced
  tool-use.
- **Self-contamination.** Because agents search live Slack, Finn's own prior runs
  started surfacing as "evidence" in later ones. The fix was retrieval hygiene:
  scope each specialist's search to its own evidence channels (so the debate never
  reads the feedback channel it posts into), plus resetting seeded state between
  demo runs.
- **Cross-region inference + IAM, demo resilience** (concurrent-agent throttling,
  per-agent failure isolation).

## Accomplishments we're proud of

- An AI decision layer you can actually **trust and audit**: autonomous where
  it's clear, human-gated where it isn't, and legible either way.
- The intellectual honesty to **test our own central claim** and rebuild the idea
  around what held.
- A clean architecture: transport-agnostic core, agents-as-data, schema output,
  disagreement-based routing, one-line-per-response governance.

## What's next

- Wire the remaining seeded evidence tools to live MCP servers (Jira/GitHub) —
  Zendesk already runs live against a real sandbox.
- Persist the *Canvas* ledger's rendered history for the deployed path (the
  queryable decision log already persists to DynamoDB).
- Run the eval the ablation seeds: does specialist debate improve decisions on
  genuinely *ambiguous* cases, with labeled ground truth?
- Ship the reusable panel-router as a template for the domains above.

## Built with

TypeScript · Node.js · Slack (Bolt, Block Kit, Canvas, App Home, reactions) ·
Slack Real-Time Search API (assistant.search.context) · a self-built Zendesk MCP server · Amazon Bedrock (Claude, Converse tool-use API) ·
AWS Lambda · API Gateway · DynamoDB · Terraform
