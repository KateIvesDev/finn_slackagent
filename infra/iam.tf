data "aws_caller_identity" "current" {}

# ── Receiver role ────────────────────────────────────────────────────────────
# Thin function: verify + ack Slack, then hand off. Needs almost nothing.
resource "aws_iam_role" "receiver" {
  name = "${var.project}-receiver"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "receiver_logs" {
  role       = aws_iam_role.receiver.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "receiver_invoke_worker" {
  name = "invoke-worker"
  role = aws_iam_role.receiver.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.worker.arn
    }]
  })
}

# ── Zendesk MCP role ─────────────────────────────────────────────────────────
# The MCP server Lambda only makes outbound HTTPS calls to Zendesk (no AWS
# permission needed for that) and writes logs — so logs-only, nothing else.
resource "aws_iam_role" "zendesk_mcp" {
  name = "${var.project}-zendesk-mcp"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "zendesk_mcp_logs" {
  role       = aws_iam_role.zendesk_mcp.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ── Worker role ──────────────────────────────────────────────────────────────
# Does the actual work: calls Bedrock, reads/writes the verdict table, posts
# to Slack (outbound HTTPS with the bot token — no AWS permission needed for
# that part).
resource "aws_iam_role" "worker" {
  name = "${var.project}-worker"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "worker_logs" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "worker_bedrock" {
  name = "bedrock-invoke"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      Resource = [
        # Anthropic (inference-profile-qualified) + Amazon Nova (bare model id)
        # — see .env.example / CLAUDE.md for why Anthropic needs the profile ARN.
        #
        # Region is wildcarded (NOT ${var.aws_region}) on the foundation-model
        # ARNs on purpose: a `us.`-prefixed inference profile is CROSS-REGION —
        # Bedrock routes the underlying InvokeModel to the member region with
        # capacity (us-east-1 / us-east-2 / us-west-2), so the identity policy
        # must permit the foundation-model in ALL of them, not just the region
        # we deploy into. Scoping to one region breaks Claude with an
        # AccessDenied on whichever sibling region the profile happens to pick.
        "arn:aws:bedrock:*::foundation-model/anthropic.*",
        "arn:aws:bedrock:*::foundation-model/amazon.*",
        "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "worker_dynamodb" {
  name = "verdict-and-decision-tables"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.verdicts.arn
      },
      {
        # The decision log records (PutItem) and the summary reads a channel's
        # recent entries (Query).
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.decisions.arn
      },
    ]
  })
}
