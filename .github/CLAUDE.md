# GitHub Actions for TWIZZ-IDP

- ci.yml: Lint + typecheck on PR/push
- deploy-dashboard.yml: Docker build -> ECR -> ECS update
- deploy-argo.yml: Sync Argo templates + ArgoCD apps to EKS

Required secret: AWS_ROLE_ARN (IAM role for OIDC federation)
