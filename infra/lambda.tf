# Both zips are produced by `npm run build:lambda` (esbuild bundle + zip —
# see scripts/build-lambda.mjs). Run that before every `terraform apply`;
# source_code_hash below makes Terraform redeploy whenever the content changes.
# Note: AWS_REGION is deliberately never set here — it's a Lambda-reserved env
# var the runtime injects automatically, and Terraform/AWS reject setting it.

resource "aws_lambda_function" "receiver" {
  function_name = "${var.project}-receiver"
  role          = aws_iam_role.receiver.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 10 # only does verify + ack + one async invoke; should be fast
  memory_size   = 256

  filename         = "${path.module}/build/receiver.zip"
  source_code_hash = filebase64sha256("${path.module}/build/receiver.zip")

  environment {
    variables = {
      SLACK_BOT_TOKEN        = var.slack_bot_token
      SLACK_SIGNING_SECRET   = var.slack_signing_secret
      SLACK_FEEDBACK_CHANNEL = var.slack_feedback_channel
      WORKER_FUNCTION_NAME   = aws_lambda_function.worker.function_name
    }
  }
}

resource "aws_lambda_function" "worker" {
  function_name = "${var.project}-worker"
  role          = aws_iam_role.worker.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  # The actual debate: 3 parallel Bedrock calls + a judge pass + Slack posts.
  # No 3-second constraint here (that's the receiver's problem) — give it room.
  timeout     = 120
  memory_size = 512

  filename         = "${path.module}/build/worker.zip"
  source_code_hash = filebase64sha256("${path.module}/build/worker.zip")

  environment {
    variables = {
      SLACK_BOT_TOKEN        = var.slack_bot_token
      SLACK_FEEDBACK_CHANNEL = var.slack_feedback_channel
      BEDROCK_MODEL_ID       = var.bedrock_model_id
      BEDROCK_STUB           = var.bedrock_stub
      VERDICT_TABLE_NAME     = aws_dynamodb_table.verdicts.name
      ZENDESK_MCP_URL        = var.zendesk_mcp_url
      SLACK_MCP_URL          = var.slack_mcp_url
      SLACK_MCP_USER_TOKEN   = var.slack_mcp_user_token
      ZENDESK_SUBDOMAIN      = var.zendesk_subdomain
      ZENDESK_EMAIL          = var.zendesk_email
      ZENDESK_API_TOKEN      = var.zendesk_api_token
      JIRA_BASE_URL          = var.jira_base_url
      JIRA_EMAIL             = var.jira_email
      JIRA_API_TOKEN         = var.jira_api_token
      JIRA_PROJECT_KEY       = var.jira_project_key
    }
  }
}

resource "aws_cloudwatch_log_group" "receiver" {
  name              = "/aws/lambda/${aws_lambda_function.receiver.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${aws_lambda_function.worker.function_name}"
  retention_in_days = 14
}
