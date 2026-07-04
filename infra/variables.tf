variable "aws_region" {
  description = "AWS region to deploy into. Must have Bedrock model access for BEDROCK_MODEL_ID."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Local AWS CLI profile Terraform uses to authenticate."
  type        = string
  default     = "slackagent"
}

variable "project" {
  description = "Name prefix for every resource this stack creates."
  type        = string
  default     = "slackagent"
}

# --- Slack ------------------------------------------------------------------
variable "slack_bot_token" {
  description = "Finn's bot token (xoxb-...). Same token used by Socket Mode locally."
  type        = string
  sensitive   = true
}

variable "slack_mcp_user_token" {
  description = "User token (xoxp-...) for mcp.slack.com — the sharks' Slack search tool. MCP's Real-time Search API requires a user token with search:read.* scopes; the bot token can't do full-text search."
  type        = string
  sensitive   = true
  default     = ""
}


variable "slack_signing_secret" {
  description = "Verifies incoming requests really came from Slack (HTTP mode replaces the app token Socket Mode used)."
  type        = string
  sensitive   = true
}

variable "slack_feedback_channel" {
  description = "Channel ID Finn listens on / posts scenario runs into (e.g. C0BEURL7803)."
  type        = string
}

# --- Bedrock ------------------------------------------------------------------
variable "bedrock_model_id" {
  description = "Inference-profile-qualified model id, e.g. us.anthropic.claude-sonnet-4-5-20250929-v1:0. Bare model IDs are rejected for on-demand invoke."
  type        = string
  default     = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
}

# --- MCP (optional; leave blank until decided) -------------------------------
variable "zendesk_mcp_url" {
  description = "Zendesk (Vaultdesk or otherwise) MCP server URL. Leave blank if not wired up yet."
  type        = string
  default     = ""
}

variable "slack_mcp_url" {
  description = "Slack MCP server URL. Leave blank if not wired up yet."
  type        = string
  default     = ""
}

# --- Zendesk / Jira sandbox creds (only needed once tools/index.ts calls real APIs) ---
variable "zendesk_subdomain" {
  type    = string
  default = ""
}
variable "zendesk_email" {
  type    = string
  default = ""
}
variable "zendesk_api_token" {
  type      = string
  default   = ""
  sensitive = true
}
variable "jira_base_url" {
  type    = string
  default = ""
}
variable "jira_email" {
  type    = string
  default = ""
}
variable "jira_api_token" {
  type      = string
  default   = ""
  sensitive = true
}
variable "jira_project_key" {
  type    = string
  default = "DEMO"
}

variable "bedrock_stub" {
  description = "Set to \"false\" to make real Bedrock Converse calls instead of the canned stub."
  type        = string
  default     = "true"
}
