# TWIZZ-IDP Setup Guide

## Prerequisites

- Node.js 20 LTS
- pnpm 9.x (`corepack enable`)
- AWS CLI configured with `twizz` profile
- kubectl with EKS access
- Pulumi CLI (`curl -fsSL https://get.pulumi.com | sh`)

## Step 1: Clone & Install

```bash
cd /root/twizz-idp
pnpm install
pnpm db:generate
```

## Step 2: Gather Credentials

You need the following credentials before anything works:

### GitHub OAuth App
1. Go to https://github.com/organizations/Twizz/settings/applications/new
2. App name: `TWIZZ-IDP`
3. Homepage URL: `http://localhost:3000` (update to `https://idp.twizz.app` for prod)
4. Callback URL: `http://localhost:3000/api/auth/callback/github`
5. Copy **Client ID** and **Client Secret**

### Vercel Token
1. Go to https://vercel.com/account/tokens
2. Create token with scope for your team
3. Team ID is already known: `team_eZiKDLZPnCBSKY38QPwbje5G`

### MongoDB Atlas API Key
1. Atlas -> Organization -> Access Manager -> Create API Key
2. Grant **Project Owner** role
3. Whitelist the ECS Fargate NAT Gateway IP (or 0.0.0.0/0 for dev)
4. Copy public key, private key, and project ID from the Atlas URL

### Anthropic API Key
1. Go to https://console.anthropic.com/settings/keys
2. Create key, copy `sk-ant-...`

### AWS Credentials (local dev only)
- ECS Fargate uses IAM task roles (no keys needed in production)
- For local dev, ensure `AWS_PROFILE=twizz` is configured

### Argo Tokens (after cluster is running)
```bash
# Argo Workflows token
kubectl -n argo create token argo-workflows-server

# Argo CD token
argocd account generate-token --account admin
```

## Step 3: Configure Environment

```bash
cp apps/dashboard/.env.local.example apps/dashboard/.env.local
# Edit .env.local with all credentials from Step 2
```

## Step 4: Local Development

```bash
# Start the dashboard
pnpm dev

# Open http://localhost:3000
# Sign in with GitHub
```

For full pipeline testing, you need the EKS cluster running (Step 5+).

## Step 5: Provision Infrastructure

```bash
cd infra
pulumi login  # or pulumi login --local
pulumi stack init dev
pulumi config set aws:region eu-west-1
pulumi config set --secret dbPassword $(openssl rand -base64 24)
pulumi config set --secret grafanaPassword $(openssl rand -base64 16)
pulumi up
```

This creates: VPC, EKS-Twizz-NonProd, ECS Fargate, RDS, ECR, DNS records.

## Step 6: Deploy Dashboard to ECS

```bash
# Build and push Docker image
aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin 848281935985.dkr.ecr.eu-west-1.amazonaws.com
docker build -t 848281935985.dkr.ecr.eu-west-1.amazonaws.com/twizz-idp:latest .
docker push 848281935985.dkr.ecr.eu-west-1.amazonaws.com/twizz-idp:latest

# ECS picks up the new image on next deploy
aws ecs update-service --cluster twizz-idp --service twizz-idp-dashboard --force-new-deployment
```

## Step 7: Seed Secrets

```bash
bash scripts/seed-secrets.sh
# Then update placeholder values in AWS Secrets Manager console
```

## Step 8: Apply Argo Templates

```bash
aws eks update-kubeconfig --name EKS-Twizz-NonProd --region eu-west-1
kubectl apply -f argo/workflow-templates/ -n argo
kubectl apply -f argo/event-sources/ -n argo
kubectl apply -f argo/applications/ -n argocd
```

## Credential Summary

| Service | Where to Get | Env Var | Prod Location |
|---------|-------------|---------|---------------|
| GitHub OAuth | github.com/organizations/Twizz/settings/applications | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | AWS Secrets Manager |
| Vercel | vercel.com/account/tokens | `VERCEL_TOKEN` | AWS Secrets Manager |
| Atlas | cloud.mongodb.com -> API Keys | `ATLAS_PUBLIC_KEY`, `ATLAS_PRIVATE_KEY`, `ATLAS_PROJECT_ID` | AWS Secrets Manager |
| Anthropic | console.anthropic.com/settings/keys | `ANTHROPIC_API_KEY` | AWS Secrets Manager |
| Argo WF | kubectl create token | `ARGO_TOKEN` | K8s service account |
| Argo CD | argocd account generate-token | `ARGOCD_AUTH_TOKEN` | K8s secret |
| AWS | IAM task role (prod) / CLI profile (dev) | `AWS_ACCESS_KEY_ID` | ECS task role |
| RDS | Pulumi output | `DATABASE_URL` | AWS Secrets Manager |
| NextAuth | openssl rand -base64 32 | `NEXTAUTH_SECRET` | AWS Secrets Manager |
