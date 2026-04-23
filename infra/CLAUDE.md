# TWIZZ-IDP Infrastructure (Pulumi)

Pulumi TypeScript IaC. Provisions networking, EKS, ECS Fargate, RDS, ECR, DNS, monitoring.

## Usage
- `pulumi config set --secret dbPassword <value>`
- `pulumi up` deploys everything

## Modules
- networking.ts: VPC, subnets, NAT, IGW
- eks.ts: EKS-Twizz-NonProd (Spot, autoscale 1-6)
- ecs.ts: ECS Fargate for IDP dashboard + ALB
- rds.ts: PostgreSQL 16 (db.t4g.micro)
- ecr.ts: twizz-idp, twizz-services, twizz-cache repos
- iam.ts: IRSA roles for ESO and Argo
- dns.ts: Route53 (idp.twizz.app + tier wildcards)
- monitoring.ts: kube-prometheus-stack
