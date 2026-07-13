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
      # @-mentioned on verdicts that route to a human (blank = no mention).
      SLACK_PRODUCT_OWNER_GROUP_ID = var.slack_product_owner_group_id
      BEDROCK_MODEL_ID             = var.bedrock_model_id
      BEDROCK_STUB                 = var.bedrock_stub
      VERDICT_TABLE_NAME           = aws_dynamodb_table.verdicts.name
      DECISION_TABLE_NAME          = aws_dynamodb_table.decisions.name
      # Point the worker at the MCP Lambda's API Gateway route + its secret.
      ZENDESK_MCP_URL      = "${aws_apigatewayv2_api.this.api_endpoint}/zendesk-mcp"
      ZENDESK_MCP_TOKEN    = var.zendesk_mcp_token
      SLACK_MCP_URL        = var.slack_mcp_url
      SLACK_MCP_USER_TOKEN = var.slack_mcp_user_token
      ZENDESK_SUBDOMAIN    = var.zendesk_subdomain
      ZENDESK_EMAIL        = var.zendesk_email
      ZENDESK_API_TOKEN    = var.zendesk_api_token
      JIRA_BASE_URL        = var.jira_base_url
      JIRA_EMAIL           = var.jira_email
      JIRA_API_TOKEN       = var.jira_api_token
      JIRA_PROJECT_KEY     = var.jira_project_key
    }
  }
}

# The Zendesk MCP server (hand-rolled JSON-RPC). The worker connects to it as an
# MCP client to pull real ticket volume + account context. Exposed via a route
# on the shared API Gateway (see apigateway.tf) — NOT a Lambda Function URL,
# because public Function URLs are blocked at the account level here. Access is
# gated in-handler by the ZENDESK_MCP_TOKEN bearer secret.
resource "aws_lambda_function" "zendesk_mcp" {
  function_name = "${var.project}-zendesk-mcp"
  role          = aws_iam_role.zendesk_mcp.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 15 # a couple of Zendesk REST calls per invocation
  memory_size   = 256

  filename         = "${path.module}/build/zendesk-mcp.zip"
  source_code_hash = filebase64sha256("${path.module}/build/zendesk-mcp.zip")

  environment {
    variables = {
      ZENDESK_SUBDOMAIN = var.zendesk_subdomain
      ZENDESK_EMAIL     = var.zendesk_email
      ZENDESK_API_TOKEN = var.zendesk_api_token
      # Bearer secret the worker must present in the X-Mcp-Token header.
      ZENDESK_MCP_TOKEN = var.zendesk_mcp_token
    }
  }
}

resource "aws_cloudwatch_log_group" "zendesk_mcp" {
  name              = "/aws/lambda/${aws_lambda_function.zendesk_mcp.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "receiver" {
  name              = "/aws/lambda/${aws_lambda_function.receiver.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${aws_lambda_function.worker.function_name}"
  retention_in_days = 14
}
