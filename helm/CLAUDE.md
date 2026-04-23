# TWIZZ-IDP Helm Charts

## twizz-service
Generic chart for any backend service. Used by Argo Workflows during deploy.
- `helm upgrade --install <release> ./helm/twizz-service/ -f values-<tier>.yaml --set image.tag=<tag> --set ingress.host=<host>`
- Templates: Deployment, Service, Ingress, HPA, ConfigMap, ExternalSecret, NetworkPolicy, ResourceQuota

## platform
Documents platform components (installed via Pulumi).

## Conventions
- values.yaml = defaults, values-{dev,staging,prod}.yaml = tier overrides
- ESO opt-in via externalSecret.enabled
