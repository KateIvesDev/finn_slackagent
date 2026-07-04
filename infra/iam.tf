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
        "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.*",
        "arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.*",
        "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "worker_dynamodb" {
  name = "verdict-table"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
      Resource = aws_dynamodb_table.verdicts.arn
    }]
  })
}
