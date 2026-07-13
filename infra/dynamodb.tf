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

# The decision ledger's queryable mirror — what "what's been decided recently?"
# reads. On Lambda the worker that records a decision and the one that answers
# the summary are separate invocations, so (like the verdicts table) the log
# can't live in memory. Keyed (channel HASH, at RANGE) so a channel's recent
# decisions are a single Query. See src/slack/decisionLog.ts.
resource "aws_dynamodb_table" "decisions" {
  name         = "${var.project}-decisions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "channel"
  range_key    = "at"

  attribute {
    name = "channel"
    type = "S"
  }

  attribute {
    name = "at"
    type = "N"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}
