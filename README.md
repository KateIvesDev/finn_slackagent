# slackagent — Finn

Product feedback lands in a Slack channel → three shark persona agents
(Support / Engineering / Product) debate it in parallel → Finn (the Judge)
resolves the debate and posts a Block Kit verdict card → you Approve/Reject →
the approved action runs. See [FINN_DESIGN.md](FINN_DESIGN.md) for the full
design intent and [CLAUDE.md](CLAUDE.md) for the architecture.

> **Status: scaffold.** Structure and end-to-end wiring are real; AI logic and
> external API calls are stubbed behind typed `// TODO:` boundaries.

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

Fill `.env` per the grouped comments in [.env.example](.env.example). For the
**skeleton demo** you don't need real credentials — the local runner is fully
stubbed.

## Verify the skeleton (no credentials needed)

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
convenes the panel, the sharks argue (each reacted to with 🤔 as it posts),
reactions resolve to 👍/👎/⚖️, and the verdict card posts with working
Approve/Reject buttons.

### Slack app config checklist (Socket Mode)

- Enable **Socket Mode**; create an app-level token with `connections:write` →
  `SLACK_APP_TOKEN`.
- Bot scopes: `chat:write`, `chat:write.customize` (shark nameplates),
  `reactions:write`, `channels:history`, `groups:history`,
  `app_mentions:read`, `users:read` (resolves the approver's display name for
  the decision ledger — Canvas markdown doesn't render `<@U…>` mentions the
  way messages do), plus canvas write scopes for the decision ledger
  (`finnledger.ts`).
- Subscribe to the `message.channels` and `app_home_opened` events.
- Install to workspace → copy the bot token (`xoxb-…`) → `SLACK_BOT_TOKEN`.

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
# Zendesk/Jira tickets + issues for the four demo scenarios (REST calls stubbed for now)
npm run seed                 # seed all scenarios
npm run seed -- bug-spike    # seed one
npm run teardown             # wipe seeded data

# Slack context substrate — channel history the sharks search via RTS
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
