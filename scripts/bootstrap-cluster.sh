#!/bin/bash
set -euo pipefail
# Bootstrap EKS-Twizz-NonProd (reference - Pulumi is primary)
CLUSTER="EKS-Twizz-NonProd"
REGION="eu-west-1"

echo "=== Bootstrapping ${CLUSTER} ==="
aws eks update-kubeconfig --name ${CLUSTER} --region ${REGION}

for ns in argo argocd external-secrets monitoring cert-manager ingress-nginx; do
  kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
done

echo "=== Namespaces created. Run 'pulumi up' from infra/ to install components ==="
