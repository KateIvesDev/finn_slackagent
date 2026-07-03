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
