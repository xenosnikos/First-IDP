#!/bin/bash
set -euo pipefail
REGION="eu-west-1"
echo "=== Seeding TWIZZ-IDP Secrets ==="

aws secretsmanager create-secret --name "twizz-idp/dashboard" --region ${REGION} \
  --secret-string '{"DATABASE_URL":"REPLACE","NEXTAUTH_SECRET":"REPLACE","GITHUB_CLIENT_ID":"REPLACE","GITHUB_CLIENT_SECRET":"REPLACE","ANTHROPIC_API_KEY":"REPLACE"}' \
  2>/dev/null || echo "twizz-idp/dashboard already exists"

aws secretsmanager create-secret --name "twizz-idp/env/dev" --region ${REGION} \
  --secret-string '{"MONGODB_URI":"REPLACE","REDIS_URL":"REPLACE"}' \
  2>/dev/null || echo "twizz-idp/env/dev already exists"

echo "=== Done. Update placeholders in AWS Secrets Manager ==="
