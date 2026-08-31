# TWIZZ-IDP Helm Charts

## twizz-service
Generic chart for any backend service. Rendered by Argo CD (ApplicationSets) for
preview/dev/staging environments on EKS-Twizz-NonProd.
- Templates: Deployment, Service, Ingress, HPA, ConfigMap, ExternalSecret, NetworkPolicy, ResourceQuota
- `values.yaml` = defaults, `values-{dev,staging,prod}.yaml` = tier overrides
- ESO opt-in via `externalSecret.enabled`
- Phase 3 adds `externalServices` (ExternalName services pointing at the `shared` namespace)

In Phase 3 the chart is vendored into `TwizzyNicky/twizz-gitops` (`charts/twizz-service/`),
which becomes the source of truth; the copy here is kept in sync until cutover.
