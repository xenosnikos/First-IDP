# TWIZZ-IDP Architecture

## Components
- **Dashboard** (ECS Fargate): Next.js 15 at idp.twizz.app
- **Database** (RDS PostgreSQL 16): IDP state
- **Pipeline Engine** (Argo Workflows): DAG CI/CD in EKS-Twizz-NonProd
- **GitOps** (Argo CD): Declarative K8s deployments
- **Secrets** (ESO + AWS SM): Zero plaintext secrets
- **Ingress** (NGINX + cert-manager): Wildcard TLS

## Environment Tiers
| Tier | URL | Lifecycle |
|------|-----|-----------|
| dev | *.dev.twizz.app | 72h TTL |
| qa | *.qa.twizz.app | manual |
| staging | *.staging.twizz.app | persistent |
| preview | *.preview.twizz.app | auto on PR merge |
| prod | *.twizz.app | approval required |
