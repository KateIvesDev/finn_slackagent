# Deploying Finn (API Gateway + 2 Lambdas + DynamoDB)

This is the judge-facing deployment: Slack's HTTP Events API instead of
Socket Mode, so Finn runs on the web without your laptop staying on. See
[CLAUDE.md](../CLAUDE.md) for why this needs two Lambdas (a thin receiver +
an async-invoked worker) instead of one.

## Prerequisites

- Terraform >= 1.7
- An AWS IAM user/profile with permission to create Lambda, API Gateway,
  DynamoDB, and IAM roles (this project uses an AWS CLI profile named
  `slackagent` — **not** the account root user; see `variables.tf`'s
  `aws_profile` if yours is named differently).
- Bedrock model access approved in this account/region for the model in
  `bedrock_model_id` (Bedrock console → Model access). If Converse calls fail
  with *"Model use case details have not been submitted for this account"*,
  that's a console-only fix, independent of everything below.

## First deploy

```bash
# from the repo root
npm run build:lambda          # bundles + zips both handlers into infra/build/

cd infra
cp terraform.tfvars.example terraform.tfvars
# fill in terraform.tfvars with real values (mirrors .env — see comments in the file)

terraform init
terraform plan                # review before applying
terraform apply
```

Grab the `slack_request_url` output:

```bash
terraform output slack_request_url
```

Then, in your Slack app config (api.slack.com → your app):

1. **Socket Mode** → turn it **off**. (The two transports are mutually
   exclusive in Slack's app settings, even though this codebase's listener
   logic works identically under either.)
2. **Event Subscriptions** → turn on, set the **Request URL** to the output
   above. Slack will send a `url_verification` challenge immediately — Bolt's
   `AwsLambdaReceiver` answers it automatically, so this should go green
   without any extra code.
3. **Interactivity & Shortcuts** → turn on, set the **Request URL** to the
   *same* URL. (Bolt's receiver tells events, button clicks, and modal
   submissions apart by inspecting the payload body — one route handles all
   of it.)
4. Reinstall the app to the workspace if Slack prompts you to (scope changes
   sometimes require this).

## Redeploying after a code change

```bash
npm run build:lambda   # re-bundles; source_code_hash changes trigger a redeploy
cd infra && terraform apply
```

## Tearing down

```bash
cd infra && terraform destroy
```

This does **not** touch anything in Slack itself (channels, the app config,
seeded messages) — only the AWS resources. Turn Socket Mode back on in the
Slack app config if you want to fall back to local dev (`npm run dev`).

## What gets created

| Resource | Purpose |
|---|---|
| `aws_apigatewayv2_api` + route + stage | One HTTP endpoint Slack posts events/interactions to |
| `aws_lambda_function.receiver` | Verifies the request, acks fast, hands off to the worker |
| `aws_lambda_function.worker` | Runs the actual shark debate + judge + executor, no time limit |
| `aws_dynamodb_table.verdicts` | Where a verdict waits between posting and a human clicking Approve/Reject — the receiver/worker split (and even separate invocations of the worker) share no memory, unlike Socket Mode's single process |
| IAM roles (2) | Least-privilege: receiver can only invoke the worker; worker can only call Bedrock + read/write the verdict table |

## Notes / tradeoffs

- **State is local** (`terraform.tfstate`, gitignored). It holds your Slack
  tokens/signing secret and any Zendesk/Jira credentials in plaintext, same
  trust boundary as `.env`. If you need shared/remote state, use an S3
  backend with SSE-KMS — not set up here to keep the hackathon setup simple.
- **`.terraform.lock.hcl` is committed** (like `package-lock.json`); local
  cache/state/tfvars are not.
