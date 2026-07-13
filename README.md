# slackagent — Finn

Product feedback lands in a Slack channel → three persona agents
(Support / Engineering / Product) debate it in parallel → Finn (the Judge)
resolves the debate and posts a Block Kit verdict card → you Approve/Reject →
the approved action runs. See [FINN_DESIGN.md](FINN_DESIGN.md) for the full
design intent and [CLAUDE.md](CLAUDE.md) for the architecture.

> **Status: working.** The debate is real — three agents run the Bedrock
> Converse tool-use loop, each grounding its argument in its own evidence
> source, and the Judge returns a schema-constrained verdict via forced
> tool-use. Deployable and running on Bedrock today. Still stubbed behind typed
> `// TODO:` boundaries: the external *write* APIs (the executor's Jira/Zendesk
> calls) and a few read-tool bodies that return seeded catalog data instead of
> live MCP.

## What makes the debate real

- **Distinct evidence per agent, not three lookups.** Support reads ticket
  volume + account context (plan / ARR / renewal); Engineering reads the issue
  tracker (defect vs enhancement, severity, effort, what's already in flight);
  Product reads the roadmap (committed themes, explicit non-goals, capacity).
  They diverge because they genuinely can't see the same evidence.
- **Judgment, not dedup.** The headline scenario: the *same* complaint produces
  a *different* action depending on the reporting account's value — the debate
  visibly changes the outcome (see the `arr-judgment` scenario).
- **Schema-constrained output via Bedrock tool-use.** Panelists and Judge return
  typed JSON through forced `submit_position` / `submit_verdict` tools — no
  fragile text-scraping ([src/agents/outputTools.ts](src/agents/outputTools.ts)).
- **Human-in-the-loop by construction.** Finn *proposes*; nothing mutates the
  outside world until a human clicks Approve. Every decision and its reasoning
  is recorded to a Slack Canvas decision ledger.
- **Governed + resilient.** One structured governance line per response — who
  asked, which model, tools used, outcome, latency
  ([src/observability/log.ts](src/observability/log.ts)); a single panelist failing
  degrades gracefully instead of wedging the thread.

## Two ways to run this

| | Local dev (Socket Mode) | Deployed (judge-facing) |
|---|---|---|
| Entrypoint | `src/slack/app.ts` | `src/lambda/receiver.ts` + `worker.ts` |
| Run with | `npm run dev` | Terraform — see [infra/README.md](infra/README.md) |
| Needs | Slack tokens in `.env` | AWS creds + `infra/terraform.tfvars` |
| Public URL? | No (outbound WebSocket) | Yes (API Gateway) |

Both run the exact same Slack listener/flow logic — see CLAUDE.md's "Two
transports, one flow" section for why the deployed version needs a Lambda
split (fast receiver + async worker) that Socket Mode doesn't.

## Requirements

- Node 20+
- (For the full Slack loop) a Slack app — Socket Mode for local dev, or HTTP
  Events API for the deployed version (see `infra/`)
- (For real AI) AWS creds + Bedrock model access (NOT the account root user)
- (For actions) Zendesk (Vaultdesk) + Slack MCP server URLs

## Setup

```bash
npm install
cp .env.example .env   # then fill in values
```

Fill `.env` per the grouped comments in [.env.example](.env.example). To try it
**without any credentials**, the local runner is fully stubbed — set
`BEDROCK_STUB=false` (plus AWS creds + `BEDROCK_MODEL_ID`) for real model calls.

## Verify without credentials

```bash
npm run typecheck   # strict TS compiles clean
npm run local       # runs orchestrate() on sample feedback, prints a stub verdict
```

`npm run local` prints a JSON verdict without touching Slack or any API — this
is your fast iteration loop for agent/judge logic. Try a scenario's trigger
text:

```bash
npm run local -- bug-spike
```

## Run locally against real Slack (Socket Mode)

Requires `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` in `.env`.

```bash
npm run dev
```

Post a message in your feedback channel (`SLACK_FEEDBACK_CHANNEL`). Finn
convenes the panel, the panelists argue their position (each reacted to with 🤔 as it posts),
reactions resolve to 👍/👎/⚖️, and the verdict card posts with working
Approve/Reject buttons.

### Slack app config checklist (Socket Mode)

- Enable **Socket Mode**; create an app-level token with `connections:write` →
  `SLACK_APP_TOKEN`.
- Bot scopes: `chat:write`, `chat:write.customize` (persona nameplates),
  `reactions:write`, `channels:history`, `groups:history`,
  `app_mentions:read`, `users:read` (resolves the approver's display name for
  the decision ledger — Canvas markdown doesn't render `<@U…>` mentions the
  way messages do), plus canvas write scopes for the decision ledger
  (`finnledger.ts`).
- Subscribe to the `message.channels` and `app_home_opened` events.
- Install to workspace → copy the bot token (`xoxb-…`) → `SLACK_BOT_TOKEN`.

### Agent-container / DM surface (Slack "Agents & Assistants")

The channel-trigger flow above is one way to talk to Finn; the Agent
container (and DMing Finn directly) is another, running the same debate
streamed live instead of as separate channel posts (`src/slack/assistant.ts`,
`src/slack/finnFlowStreamed.ts`). To turn it on:

- Enable **Agents & Assistants** in the app's settings — new apps are put on
  the **agent_view** messaging experience (this auto-adds `assistant:write`).
- Subscribe to `app_home_opened`, `app_context_changed`, and `message.im` in
  addition to the events above.
- Reinstall the app to pick up the new scope.
- Requires `@slack/bolt@^4.4.0+` / `@slack/web-api@^7.x` for
  `chat.startStream`/`appendStream`/`stopStream` and
  `assistant.threads.setStatus`/`setSuggestedPrompts`/`setTitle`. Note: Bolt's
  own `Assistant` class only wraps the *older* assistant_view events
  (`assistant_thread_started` etc.) and does nothing under agent_view — Finn
  talks to agent_view directly with plain `app.event`/`app.message` listeners
  instead (`registerFinnAgent` in `src/slack/assistant.ts`).

## Deploy it (judge-facing, runs on the web)

See [infra/README.md](infra/README.md) for the full walkthrough. Short
version:

```bash
npm run build:lambda
cd infra
cp terraform.tfvars.example terraform.tfvars   # fill in real values
terraform init && terraform plan && terraform apply
```

Then point your Slack app's Event Subscriptions + Interactivity Request URLs
at the `slack_request_url` output, and turn Socket Mode off there (the two
are mutually exclusive in Slack's app config).

## Seeding demo data

Two independent things to seed, both idempotent/resettable:

```bash
# Zendesk/Jira tickets + issues for the six demo scenarios (REST calls stubbed for now)
npm run seed                 # seed all scenarios
npm run seed -- bug-spike    # seed one
npm run teardown             # wipe seeded data

# Slack context substrate — channel history the persona agents search via the Slack MCP server
npm run seed:slack
npm run reset:slack -- --all              # clear the seeded context substrate
npm run reset:slack -- --stage            # wipe the live demo channel between runs
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Bolt app in Socket Mode (`tsx watch`) — local dev |
| `npm run local` | Run `orchestrate()` locally, print verdict — no Slack |
| `npm run build:lambda` | Bundle + zip both Lambda handlers for Terraform |
| `npm run seed` / `teardown` | Zendesk/Jira sandbox data (idempotent, stubbed) |
| `npm run seed:slack` / `reset:slack` | Slack context-substrate channel history |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

## Project layout

See [CLAUDE.md](CLAUDE.md) for the full architecture, the two-transport
design, and the recommended fill-in order.
