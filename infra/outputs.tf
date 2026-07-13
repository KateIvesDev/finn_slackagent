output "slack_request_url" {
  description = "Set this as BOTH the Event Subscriptions Request URL and the Interactivity Request URL in your Slack app config (api.slack.com)."
  value       = "${aws_apigatewayv2_api.this.api_endpoint}/slack/events"
}

output "receiver_function_name" {
  value = aws_lambda_function.receiver.function_name
}

output "worker_function_name" {
  value = aws_lambda_function.worker.function_name
}

output "zendesk_mcp_url" {
  description = "API Gateway route for the Zendesk MCP Lambda (the worker is wired to it automatically; shown for debugging/curl)."
  value       = "${aws_apigatewayv2_api.this.api_endpoint}/zendesk-mcp"
}

output "verdict_table_name" {
  value = aws_dynamodb_table.verdicts.name
}
