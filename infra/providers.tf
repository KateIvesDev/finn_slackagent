terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # Local state for a hackathon deploy. If this needs to survive/be shared
  # beyond one person's laptop, swap this for an S3 backend (with a DynamoDB
  # lock table) — but note local state already holds the Slack tokens/signing
  # secret as plain values (same trust boundary as .env), so a remote backend
  # should be encrypted (SSE-KMS) if you add one.
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}
