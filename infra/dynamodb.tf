# Holds a verdict between the debate finishing (posted by the worker) and a
# human clicking Approve/Reject (handled by a later, separate invocation).
# See src/slack/verdictStore.ts — DynamoVerdictStore is the only reason this
# table exists; Socket Mode's InMemoryVerdictStore needs no such thing since
# it's one long-lived process.
resource "aws_dynamodb_table" "verdicts" {
  name         = "${var.project}-verdicts"
  billing_mode = "PAY_PER_REQUEST" # hackathon-scale traffic; no capacity planning needed
  hash_key     = "feedbackId"

  attribute {
    name = "feedbackId"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}
