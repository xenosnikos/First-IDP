# TWIZZ-IDP Argo Configuration

## Workflow Templates
- build-and-deploy-backend.yaml: Main backend CI/CD (DAG)
- build-and-deploy-frontend.yaml: Vercel frontend deploy
- provision-database.yaml: MongoDB Atlas DB provisioning
- run-checks.yaml: 6 automated release checks (DAG, parallel)
- promote-release.yaml: Promotion with approval gates

## Event Sources
- github-webhook.yaml: GitHub push/PR triggers

## Applications
- platform.yaml: ArgoCD self-managing platform chart
