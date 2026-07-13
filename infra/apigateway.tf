# One HTTP API, one route, one Lambda behind it. Slack can point BOTH the
# Event Subscriptions Request URL and the Interactivity Request URL at the
# same route — Bolt's receiver inspects the payload body to tell events,
# interactive components, and view submissions apart.
#
# payload_format_version = "1.0" makes the HTTP API emit the older REST-API
# proxy-integration event shape, which is what @slack/bolt's AwsLambdaReceiver
# expects (it wasn't written against the newer v2.0 payload shape).

resource "aws_apigatewayv2_api" "this" {
  name          = "${var.project}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "receiver" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.receiver.invoke_arn
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "slack_events" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "POST /slack/events"
  target    = "integrations/${aws_apigatewayv2_integration.receiver.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw_invoke_receiver" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.receiver.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

# --- Zendesk MCP behind the same HTTP API ------------------------------------
# Public route (no authorizer), gated in-handler by the X-Mcp-Token bearer
# secret. payload_format_version 2.0 here (NOT 1.0 like the Bolt receiver) —
# the MCP handler reads the v2 event shape (requestContext.http.method,
# lowercased headers). Function URLs would be simpler, but public ones are
# blocked at the account level, so we reuse the API Gateway the receiver proves
# works.
resource "aws_apigatewayv2_integration" "zendesk_mcp" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.zendesk_mcp.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "zendesk_mcp" {
  api_id = aws_apigatewayv2_api.this.id
  # ANY (not just POST) so a GET SSE-stream probe from the MCP client reaches the
  # handler and gets a 405 (which the client tolerates) rather than an API GW 404.
  route_key = "ANY /zendesk-mcp"
  target    = "integrations/${aws_apigatewayv2_integration.zendesk_mcp.id}"
}

resource "aws_lambda_permission" "apigw_invoke_zendesk_mcp" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.zendesk_mcp.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
