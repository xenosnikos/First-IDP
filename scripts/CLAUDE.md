# Operational Scripts

- bootstrap-cluster.sh: One-time EKS namespace setup (Pulumi is primary)
- seed-secrets.sh: Initial AWS Secrets Manager seeding
- migrate-prod-to-argocd.sh: Phase 6 production migration (NOT READY)
- nebula-allow-login.sh / nebula-set-observer-key.sh / create-nebula-secret.sh: Nebula sign-in allowlist, Observer key, nebula SM blob (run with `!`; SM writes)
- staging-sentinel-bootstrap.sh: release-train staging tier one-time setup (SM `staging/twizz-sentinel` + `staging/twizz-admin`, ns `sentinel` on EKS-Moly-staging, admin k8s Secret mirror); `--rotate` mints new keys
