#!/usr/bin/env bash
# Pulumi state backend for twizz-idp (2026-11-06). The original infra/ state (a local
# passphrase backend on the old WSL machine) was lost; see infra/CLAUDE.md. This creates,
# idempotently, an S3 state bucket (versioned, SSE-KMS, private, TLS-only) and a KMS key
# for stack secrets. Then:
#   pulumi login s3://twizz-idp-pulumi-state-848281935985?region=eu-west-1&awssdk=v2&profile=twizz
#   cd infra/addons && pulumi stack init nonprod --secrets-provider "awskms://alias/twizz-idp-pulumi?region=eu-west-1"
#
#   AWS_PROFILE=twizz bash scripts/pulumi-backend-bootstrap.sh
set -euo pipefail
REGION=eu-west-1
ACCOUNT=848281935985
BUCKET=twizz-idp-pulumi-state-$ACCOUNT
ALIAS=alias/twizz-idp-pulumi

echo "== bucket $BUCKET"
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'
aws s3api put-bucket-ownership-controls --bucket "$BUCKET" --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"TlsOnly\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$BUCKET\",\"arn:aws:s3:::$BUCKET/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging 'TagSet=[{Key=Project,Value=twizz-idp},{Key=Purpose,Value=pulumi-state}]'
echo "   ok"

echo "== KMS $ALIAS (stack secrets)"
if ! aws kms describe-key --region "$REGION" --key-id "$ALIAS" >/dev/null 2>&1; then
  KEY=$(aws kms create-key --region "$REGION" --description "twizz-idp Pulumi stack secrets" --tags TagKey=Project,TagValue=twizz-idp --query KeyMetadata.KeyId --output text)
  aws kms create-alias --region "$REGION" --alias-name "$ALIAS" --target-key-id "$KEY"
  aws kms enable-key-rotation --region "$REGION" --key-id "$KEY"
fi
aws kms describe-key --region "$REGION" --key-id "$ALIAS" --query 'KeyMetadata.[KeyId,KeyState]' --output text
echo "backend: s3://$BUCKET  secrets: awskms://$ALIAS?region=$REGION"
